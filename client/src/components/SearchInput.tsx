import React, { useState } from 'react';

interface SearchInputProps {
  onSubmit: (query: string) => Promise<void>;
  disabled: boolean;
}

export default function SearchInput({ onSubmit, disabled }: SearchInputProps): React.ReactElement {
  const [input, setInput] = useState<string>('');

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (input.trim() && !disabled) {
      void onSubmit(input);
      setInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      void handleSubmit(e as unknown as React.FormEvent<HTMLFormElement>);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={handleKeyPress}
        placeholder="Search for AI incidents..."
        disabled={disabled}
        className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
      />
      <button
        type="submit"
        disabled={disabled || !input.trim()}
        className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
      >
        {disabled ? 'Searching...' : 'Search'}
      </button>
    </form>
  );
}
