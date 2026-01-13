import { Box, Text, useInput } from 'ink';
import React from 'react';
import { CANCELED_MESSAGE_TEXT } from '../constants';
import type { Message } from '../message';
import { isCanceledMessage } from '../message';
import { UI_COLORS } from './constants';

interface ForkModalProps {
  messages: (Message & {
    uuid: string;
    parentUuid: string | null;
    timestamp: string;
  })[];
  onSelect: (uuid: string) => void;
  onClose: () => void;
}

const getMessageText = (message: Message): string => {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join(' ');
  }
  return '';
};

const hasBashStdout = (text: string): boolean => {
  return text.includes('<bash-stdout>');
};

const extractBashInput = (text: string): string | null => {
  const match = text.match(/<bash-input>([\s\S]*?)<\/bash-input>/);
  return match ? match[1] : null;
};

export function ForkModal({ messages, onSelect, onClose }: ForkModalProps) {
  const [selectedIndex, setSelectedIndex] = React.useState(0);

  // Filter to user messages only and reverse for chronological order (newest first)
  const userMessages = React.useMemo(
    () =>
      messages
        .filter((m) => {
          if (m.role !== 'user') return false;
          if ('hidden' in m && m.hidden) return false;
          if (isCanceledMessage(m)) return false;
          const text = getMessageText(m);
          if (text === CANCELED_MESSAGE_TEXT) return false;
          if (hasBashStdout(text)) return false;
          return true;
        })
        .reverse(),
    [messages],
  );

  useInput((input, key) => {
    if (key.escape) {
      onClose();
    } else if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(userMessages.length - 1, prev + 1));
    } else if (key.return) {
      if (userMessages[selectedIndex]) {
        onSelect(userMessages[selectedIndex].uuid!);
      }
    }
  });

  const getMessagePreview = (
    message: Message,
  ): { text: string; isBashInput: boolean } => {
    let text = getMessageText(message);
    const bashInput = extractBashInput(text);
    if (bashInput !== null) {
      text = bashInput.replace(/\s+/g, ' ').trim();
      const truncated = text.length > 80 ? text.slice(0, 80) + '...' : text;
      return { text: truncated, isBashInput: true };
    }
    text = text.replace(/\s+/g, ' ').trim();
    const truncated = text.length > 80 ? text.slice(0, 80) + '...' : text;
    return { text: truncated, isBashInput: false };
  };

  const getTimestamp = (message: Message & { timestamp: string }): string => {
    if (!message.timestamp) return '';
    const date = new Date(message.timestamp);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  };

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      padding={1}
      width="100%"
    >
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Jump to Previous Message
        </Text>
      </Box>
      <Box flexDirection="column">
        {userMessages.length === 0 ? (
          <Text dimColor>No previous messages to jump to</Text>
        ) : (
          userMessages.map((message, index) => {
            const isSelected = index === selectedIndex;
            const { text: preview, isBashInput } = getMessagePreview(message);
            const timestamp = getTimestamp(message);

            return (
              <Box key={message.uuid} marginBottom={0}>
                <Text
                  color={isSelected ? 'cyan' : 'white'}
                  bold={isSelected}
                  backgroundColor={isSelected ? 'blue' : undefined}
                >
                  {isSelected ? '> ' : '  '}
                  {timestamp} |{' '}
                </Text>
                {isBashInput && (
                  <Text
                    color={UI_COLORS.CHAT_BORDER_BASH}
                    bold={isSelected}
                    backgroundColor={isSelected ? 'blue' : undefined}
                  >
                    !{' '}
                  </Text>
                )}
                <Text
                  color={isSelected ? 'cyan' : 'white'}
                  bold={isSelected}
                  backgroundColor={isSelected ? 'blue' : undefined}
                >
                  {preview}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Use ↑/↓ to navigate, Enter to select, Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
