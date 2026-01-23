import { execSync } from 'child_process';
import clipboardy from 'clipboardy';
import { Box, render, Text, useInput } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Context } from '../context';
import { DirectTransport, MessageBus } from '../messageBus';
import { NodeBridge } from '../nodeBridge';
import { TerminalSizeProvider } from '../ui/TerminalSizeContext';
import TextInput from '../ui/TextInput';
import { sanitizeAIResponse } from '../utils/sanitizeAIResponse';

// ============================================================================
// Types
// ============================================================================

type RunState =
  | { phase: 'idle' }
  | { phase: 'generating'; prompt: string }
  | { phase: 'displaying'; command: string; prompt: string }
  | { phase: 'editing'; command: string; prompt: string; editedCommand: string }
  | {
      phase: 'editingPrompt';
      command: string;
      prompt: string;
      editedPrompt: string;
    }
  | { phase: 'executing'; command: string }
  | { phase: 'success'; command: string; output: string }
  | { phase: 'error'; command: string; prompt: string; error: string }
  | { phase: 'cancelled' };

type RunAction =
  | 'execute'
  | 'copy'
  | 'edit'
  | 'regenerate'
  | 'cancel'
  | 'retry';

interface RunOptions {
  model?: string;
  yes: boolean;
  quiet: boolean;
}

interface RunUIProps {
  messageBus: MessageBus;
  cwd: string;
  options: RunOptions;
  initialPrompt?: string;
}

// ============================================================================
// System Prompt
// ============================================================================

const SHELL_COMMAND_SYSTEM_PROMPT = `
You are a tool that converts natural language instructions into shell commands.
Your task is to transform user's natural language requests into precise and effective shell commands.

Please follow these rules:
1. Output only the shell command, without explanations or additional content
2. If the user directly provides a shell command, return that command as is
3. If the user describes a task in natural language, convert it to the most appropriate shell command
4. Avoid using potentially dangerous commands (such as rm -rf /)
5. Provide complete commands, avoiding placeholders
6. Reply with only one command, don't provide multiple options or explanations
7. When no suitable command can be found, return the recommended command directly

Examples:
User: "List all files in the current directory"
Reply: "ls -la"

User: "Create a new directory named test"
Reply: "mkdir test"

User: "Find all log files containing 'error'"
Reply: "find . -name '*.log' -exec grep -l 'error' {} \\\\;"

User: "ls -la" (user directly provided a command)
Reply: "ls -la"

User: "I want to compress all images in the current directory"
Reply: "find . -type f ( -iname "*.jpg" -o -iname "*.jpeg" -o -iname "*.png" ) -exec mogrify -quality 85% {} \\\\;"
`;

// ============================================================================
// Helper Functions
// ============================================================================

function executeShell(
  command: string,
  cwd: string,
): { success: boolean; output: string } {
  try {
    const output = execSync(command, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000, // 60s timeout
    });
    return { success: true, output: output?.toString() || '' };
  } catch (error: any) {
    // For execSync errors, stderr is in error.stderr
    const errorOutput =
      error.stderr?.toString() ||
      error.stdout?.toString() ||
      error.message ||
      'Command execution failed';
    return { success: false, output: errorOutput };
  }
}

// ============================================================================
// RunActionSelector Component
// ============================================================================

interface ActionItem {
  value: RunAction;
  label: string;
  key: string;
}

const BASE_ACTIONS: ActionItem[] = [
  { value: 'execute', label: 'Execute', key: '1' },
  { value: 'copy', label: 'Copy to clipboard', key: '2' },
  { value: 'edit', label: 'Edit command', key: '3' },
  { value: 'regenerate', label: 'Edit prompt & regenerate', key: '4' },
];

const TAIL_ACTIONS: ActionItem[] = [
  { value: 'cancel', label: 'Cancel', key: 'q' },
];

interface RunActionSelectorProps {
  onSelect: (action: RunAction) => void;
  onCancel: () => void;
  disabled?: boolean;
  showRetry?: boolean;
}

const RunActionSelector: React.FC<RunActionSelectorProps> = ({
  onSelect,
  onCancel,
  disabled = false,
  showRetry = false,
}) => {
  const actions = useMemo(() => {
    const baseActions = showRetry
      ? [
          { value: 'retry' as RunAction, label: 'Retry', key: '1' },
          ...BASE_ACTIONS.slice(1),
        ]
      : BASE_ACTIONS;
    return [...baseActions, ...TAIL_ACTIONS];
  }, [showRetry]);

  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput(
    (input, key) => {
      if (disabled) return;

      if (key.escape || input === 'q') {
        onCancel();
        return;
      }

      if (key.return) {
        onSelect(actions[selectedIndex].value);
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : actions.length - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < actions.length - 1 ? prev + 1 : 0));
        return;
      }

      // Quick select by key
      const action = actions.find((a) => a.key === input);
      if (action) {
        onSelect(action.value);
      }
    },
    { isActive: !disabled },
  );

  return (
    <Box flexDirection="column">
      <Text>Actions:</Text>
      <Box flexDirection="column">
        {actions.map((action, index) => {
          const isSelected = index === selectedIndex;
          const prefix = isSelected ? '>' : ' ';
          const keyLabel = `[${action.key}]`;

          return (
            <Box key={action.value}>
              <Text color={isSelected ? 'cyan' : undefined} dimColor={disabled}>
                {prefix} {keyLabel} {action.label}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text> </Text>
      <Text dimColor>↑↓ select enter confirm q cancel</Text>
    </Box>
  );
};

// ============================================================================
// Error Display Component
// ============================================================================

interface ErrorDisplayProps {
  error: string;
  onExit: () => void;
}

const ErrorDisplay: React.FC<ErrorDisplayProps> = ({ error, onExit }) => {
  useInput((input, key) => {
    if (key.escape || input === 'n' || input === 'N') {
      onExit();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="red">error: {error}</Text>
      <Text> </Text>
      <Text dimColor>esc exit</Text>
    </Box>
  );
};

// ============================================================================
// Main UI Component
// ============================================================================

const RunUI: React.FC<RunUIProps> = ({
  messageBus,
  cwd,
  options,
  initialPrompt,
}) => {
  const [state, setState] = useState<RunState>(() =>
    initialPrompt
      ? { phase: 'generating', prompt: initialPrompt }
      : { phase: 'idle' },
  );
  const [promptInput, setPromptInput] = useState('');
  const [shouldExit, setShouldExit] = useState(false);

  // Handle exit
  useEffect(() => {
    if (shouldExit) {
      process.exit(0);
    }
  }, [shouldExit]);

  // Handle keyboard input for global actions
  useInput((_input, key) => {
    if (key.escape) {
      if (state.phase === 'idle' || state.phase === 'generating') {
        setShouldExit(true);
      } else if (state.phase === 'editing') {
        // Cancel editing, go back to displaying
        setState({
          phase: 'displaying',
          command: state.command,
          prompt: state.prompt,
        });
      } else if (state.phase === 'editingPrompt') {
        // Cancel prompt editing, go back to displaying
        setState({
          phase: 'displaying',
          command: state.command,
          prompt: state.prompt,
        });
      } else if (
        state.phase === 'displaying' ||
        state.phase === 'success' ||
        state.phase === 'cancelled'
      ) {
        setShouldExit(true);
      }
    }
  });

  // Generate command from prompt
  const generateCommand = useCallback(
    async (prompt: string) => {
      setState({ phase: 'generating', prompt });

      try {
        const result = await messageBus.request('utils.quickQuery', {
          cwd,
          userPrompt: prompt,
          systemPrompt: SHELL_COMMAND_SYSTEM_PROMPT,
          model: options.model,
        });

        const rawCommand = result.success ? result.data?.text : null;
        const command = rawCommand ? sanitizeAIResponse(rawCommand) : null;

        if (!command) {
          setState({
            phase: 'error',
            command: '',
            prompt,
            error: result.error || 'Failed to generate command from AI',
          });
          return;
        }

        // If --yes flag, execute immediately
        if (options.yes) {
          setState({ phase: 'executing', command });
          const execResult = executeShell(command, cwd);

          if (execResult.success) {
            setState({
              phase: 'success',
              command,
              output: execResult.output,
            });
            // Auto-exit after showing result
            setTimeout(() => setShouldExit(true), 1500);
          } else {
            setState({
              phase: 'error',
              command,
              prompt,
              error: execResult.output,
            });
          }
        } else {
          setState({ phase: 'displaying', command, prompt });
        }
      } catch (error: any) {
        setState({
          phase: 'error',
          command: '',
          prompt,
          error: error.message || 'Failed to generate command',
        });
      }
    },
    [messageBus, cwd, options.yes, options.model],
  );

  // Auto-generate if initial prompt provided
  useEffect(() => {
    if (initialPrompt && state.phase === 'generating') {
      generateCommand(initialPrompt);
    }
  }, [initialPrompt, generateCommand, state.phase]);

  // Handle prompt submission
  const handlePromptSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;
      generateCommand(value.trim());
    },
    [generateCommand],
  );

  // Handle action selection
  const handleAction = useCallback(
    async (action: RunAction) => {
      if (state.phase !== 'displaying' && state.phase !== 'error') return;

      const command = state.command;
      const prompt = state.prompt;

      switch (action) {
        case 'execute':
        case 'retry': {
          setState({ phase: 'executing', command });
          const result = executeShell(command, cwd);

          if (result.success) {
            setState({
              phase: 'success',
              command,
              output: result.output,
            });
          } else {
            setState({
              phase: 'error',
              command,
              prompt,
              error: result.output,
            });
          }
          break;
        }

        case 'copy': {
          clipboardy.writeSync(command);
          setState({
            phase: 'success',
            command,
            output: 'Copied to clipboard',
          });
          setTimeout(() => setShouldExit(true), 1000);
          break;
        }

        case 'edit': {
          setState({
            phase: 'editing',
            command,
            prompt,
            editedCommand: command,
          });
          break;
        }

        case 'regenerate': {
          setState({
            phase: 'editingPrompt',
            command,
            prompt,
            editedPrompt: prompt,
          });
          break;
        }

        case 'cancel': {
          setState({ phase: 'cancelled' });
          setShouldExit(true);
          break;
        }
      }
    },
    [state, cwd],
  );

  // Handle edit submission
  const handleEditSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;
      if (state.phase === 'editing') {
        setState({
          phase: 'displaying',
          command: value.trim(),
          prompt: state.prompt,
        });
      }
    },
    [state],
  );

  // Handle prompt edit submission
  const handlePromptEditSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;
      generateCommand(value.trim());
    },
    [generateCommand],
  );

  // Render based on current state
  return (
    <Box flexDirection="column" padding={1}>
      {/* Idle Phase - Prompt Input */}
      {state.phase === 'idle' && (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={promptInput}
              onChange={setPromptInput}
              onSubmit={handlePromptSubmit}
              placeholder="Describe what you want to do..."
              // Account for "> " prefix (2) + outer padding (1)
              columns={{ useTerminalSize: true, prefix: 3 }}
            />
          </Box>
          <Text> </Text>
          <Text dimColor>enter submit esc exit</Text>
        </Box>
      )}

      {/* Generating Phase */}
      {state.phase === 'generating' && (
        <Box>
          <Text color="yellow">Generating command with {options.model}...</Text>
        </Box>
      )}

      {/* Displaying Phase */}
      {state.phase === 'displaying' && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <RunActionSelector
            onSelect={handleAction}
            onCancel={() => setShouldExit(true)}
          />
        </Box>
      )}

      {/* Editing Phase */}
      {state.phase === 'editing' && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <Text>Edit command:</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={state.editedCommand}
              onChange={(value) =>
                setState((prev) =>
                  prev.phase === 'editing'
                    ? { ...prev, editedCommand: value }
                    : prev,
                )
              }
              onSubmit={handleEditSubmit}
              // Account for "> " prefix (2) + outer padding (1)
              columns={{ useTerminalSize: true, prefix: 3 }}
            />
          </Box>
          <Text> </Text>
          <Text dimColor>enter save esc cancel</Text>
        </Box>
      )}

      {/* Editing Prompt Phase */}
      {state.phase === 'editingPrompt' && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <Text>Edit prompt:</Text>
          <Box>
            <Text color="cyan">{'> '}</Text>
            <TextInput
              value={state.editedPrompt}
              onChange={(value) =>
                setState((prev) =>
                  prev.phase === 'editingPrompt'
                    ? { ...prev, editedPrompt: value }
                    : prev,
                )
              }
              onSubmit={handlePromptEditSubmit}
              // Account for "> " prefix (2) + outer padding (1)
              columns={{ useTerminalSize: true, prefix: 3 }}
            />
          </Box>
          <Text> </Text>
          <Text dimColor>enter regenerate esc cancel</Text>
        </Box>
      )}

      {/* Executing Phase */}
      {state.phase === 'executing' && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <Text dimColor>Executing...</Text>
        </Box>
      )}

      {/* Success Phase */}
      {state.phase === 'success' && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <Text color="green">
            ok: {state.output || 'Command executed successfully'}
          </Text>
          <Text> </Text>
          <Text dimColor>esc exit</Text>
        </Box>
      )}

      {/* Error Phase with command */}
      {state.phase === 'error' && state.command && (
        <Box flexDirection="column">
          <Text>
            <Text dimColor>command: </Text>
            <Text color="yellow">{state.command}</Text>
          </Text>
          <Text> </Text>
          <Text color="red">error: {state.error}</Text>
          <Text> </Text>
          <RunActionSelector
            onSelect={handleAction}
            onCancel={() => setShouldExit(true)}
            showRetry={true}
          />
        </Box>
      )}

      {/* Error Phase (no command - generation failed) */}
      {state.phase === 'error' && !state.command && (
        <ErrorDisplay error={state.error} onExit={() => setShouldExit(true)} />
      )}

      {/* Cancelled Phase */}
      {state.phase === 'cancelled' && (
        <Box>
          <Text dimColor>Cancelled.</Text>
        </Box>
      )}
    </Box>
  );
};

// ============================================================================
// Help Text
// ============================================================================

function printHelp(productName: string) {
  console.log(
    `
Usage:
  ${productName} run [options] <prompt>

Convert natural language to shell commands using AI and optionally execute them.

Arguments:
  prompt                Natural language description of what you want to do

Options:
  -h, --help            Show help
  -m, --model <model>   Specify model to use
  -q, --quiet           Quiet mode, output only the command (requires prompt)
  --yes                 Execute the command without confirmation

Examples:
  ${productName} run "list all files in current directory"
  ${productName} run "find all .js files modified in last 7 days"
  ${productName} run --yes "update all npm dependencies"
  ${productName} run -q "compress all images" | pbcopy
    `.trim(),
  );
}

// ============================================================================
// Quiet Mode
// ============================================================================

async function runQuiet(
  context: Context,
  prompt: string,
  options: RunOptions,
): Promise<void> {
  try {
    // Initialize NodeBridge and message bus
    const nodeBridge = new NodeBridge({
      contextCreateOpts: {
        productName: context.productName,
        version: context.version,
        argvConfig: {},
        plugins: context.plugins,
      },
    });

    const [quietTransport, nodeTransport] = DirectTransport.createPair();
    const messageBus = new MessageBus();
    messageBus.setTransport(quietTransport);
    nodeBridge.messageBus.setTransport(nodeTransport);

    // Generate command via AI
    const result = await messageBus.request('utils.quickQuery', {
      cwd: context.cwd,
      userPrompt: prompt,
      systemPrompt: SHELL_COMMAND_SYSTEM_PROMPT,
      model: options.model,
    });

    const rawCommand = result.success ? result.data?.text : null;
    const command = rawCommand ? sanitizeAIResponse(rawCommand) : null;

    if (!command) {
      console.error(result.error || 'Failed to generate command from AI');
      process.exit(1);
    }

    // Output plain text command to stdout
    console.log(command);
    process.exit(0);
  } catch (error: any) {
    console.error(error.message || 'Failed to generate command');
    process.exit(1);
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

export async function runRun(context: Context) {
  const { default: yargsParser } = await import('yargs-parser');
  const argv = yargsParser(process.argv.slice(2), {
    alias: {
      model: 'm',
      help: 'h',
      yes: 'y',
      quiet: 'q',
    },
    boolean: ['help', 'yes', 'quiet'],
    string: ['model'],
  });

  // Help
  if (argv.help) {
    printHelp(context.productName.toLowerCase());
    return;
  }

  // Get initial prompt from CLI args
  const initialPrompt = argv._[1] as string | undefined;

  const options: RunOptions = {
    model: argv.model || context.config.smallModel || context.config.model,
    yes: argv.yes || false,
    quiet: argv.quiet || false,
  };

  // Quiet mode: output only the command, no UI
  if (options.quiet) {
    if (!initialPrompt?.trim()) {
      console.error('Error: Prompt is required in quiet mode');
      process.exit(1);
    }
    await runQuiet(context, initialPrompt.trim(), options);
    return;
  }

  try {
    // Initialize NodeBridge and message bus
    const nodeBridge = new NodeBridge({
      contextCreateOpts: {
        productName: context.productName,
        version: context.version,
        argvConfig: {},
        plugins: context.plugins,
      },
    });

    const [uiTransport, nodeTransport] = DirectTransport.createPair();
    const uiMessageBus = new MessageBus();
    uiMessageBus.setTransport(uiTransport);
    nodeBridge.messageBus.setTransport(nodeTransport);

    // Render the UI
    render(
      <TerminalSizeProvider>
        <RunUI
          messageBus={uiMessageBus}
          cwd={context.cwd}
          options={options}
          initialPrompt={initialPrompt?.trim()}
        />
      </TerminalSizeProvider>,
      {
        patchConsole: true,
        exitOnCtrlC: true,
      },
    );

    // Handle process signals
    const exit = () => {
      process.exit(0);
    };
    process.on('SIGINT', exit);
    process.on('SIGTERM', exit);
  } catch (error: any) {
    console.error('Error initializing run command:', error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}
