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
        className={`max-w-xs lg:max-w-md xl:max-w-lg px-4 py-3 rounded-lg ${
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
            {results.slice(0, 3).map((result, index) => (
              <div
                key={index}
                className="bg-gray-100 rounded p-2 text-xs text-gray-700 border-l-2 border-blue-400"
              >
                <div className="font-semibold truncate">{result.title || 'Untitled'}</div>
                <div className="text-gray-600 text-xs mt-1">
                  Relevance: {result.relevanceScore}%
                </div>
                {result.description && (
                  <div className="text-gray-600 mt-1 line-clamp-2">
                    {result.description.substring(0, 100)}...
                  </div>
                )}
              </div>
            ))}
            {results.length > 3 && (
              <div className="text-xs text-gray-600 italic">
                +{results.length - 3} more results
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
