import React from 'react';
import { IncidentWithScore, ChatMessage as ChatMessageType } from '../types';

interface ChatMessageProps {
  message: ChatMessageType;
  results?: IncidentWithScore[];
}

export default function ChatMessage({ message, results }: ChatMessageProps): React.ReactElement {
  const isBot = message.type === 'bot';

  return (
    <div className={`flex ${isBot ? 'justify-start' : 'justify-end'} mb-4`}>
      <div
        className={`px-4 py-3 rounded-lg ${
          results && results.length > 0 ? 'w-full max-w-3xl' : 'max-w-xs lg:max-w-md xl:max-w-lg'
        } ${
          isBot
            ? 'bg-gray-200 text-gray-800'
            : 'bg-blue-500 text-white'
        }`}
      >
        <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
        <p className={`text-xs mt-1 ${isBot ? 'text-gray-600' : 'text-blue-100'}`}>
          {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>

        {/* Results List */}
        {results && results.length > 0 && (
          <div className="mt-3 space-y-2">
            {results.map((result, index) => (
              <div
                key={`${result.id}-${index}`}
                className="bg-gray-100 rounded p-3 text-sm text-gray-700 border-l-2 border-blue-400"
              >
                <div className="font-semibold break-words">
                  {index + 1}. {result.title || 'Untitled'}
                </div>
                <div className="text-gray-600 text-xs mt-1">
                  Relevance: {result.relevanceScore}%
                  {result.date ? ` · ${result.date}` : ''}
                  {result.category ? ` · ${result.category}` : ''}
                </div>
                {result.description && (
                  <div className="text-gray-700 mt-2 break-words">{result.description}</div>
                )}
                {typeof result.Tags === 'string' && result.Tags && (
                  <div className="text-xs text-gray-500 mt-2">Tags: {result.Tags}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
