import React, { useState, useRef, useEffect } from 'react';
import axios from 'axios';
import ChatMessage from './components/ChatMessage';
import SearchInput from './components/SearchInput';
import { ChatMessage as ChatMessageType, SearchResponse } from './types';

function App(): React.ReactElement {
  const [messages, setMessages] = useState<ChatMessageType[]>([
    {
      id: 1,
      type: 'bot',
      text: 'Hello! I\'m an AI incident search assistant. Type a query to find related incidents in our database.',
      timestamp: new Date()
    }
  ]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = (): void => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSearch = async (query: string): Promise<void> => {
    if (!query.trim()) return;

    // Add user message
    const userMessage: ChatMessageType = {
      id: messages.length + 1,
      type: 'user',
      text: query,
      timestamp: new Date()
    };
    setMessages(prev => [...prev, userMessage]);
    setLoading(true);
    setError(null);

    try {
      // Call backend API
      const response = await axios.post<SearchResponse>('/api/search', { query });
      const { results, totalMatches } = response.data;

      // Format results as bot message
      const resultText = results.length > 0
        ? formatResults(results, query, totalMatches)
        : 'No matching incidents found. Try a different query.';

      const botMessage: ChatMessageType = {
        id: messages.length + 2,
        type: 'bot',
        text: resultText,
        timestamp: new Date(),
        results: results
      };

      setMessages(prev => [...prev, botMessage]);
    } catch (err) {
      const errorMessage = 
        axios.isAxiosError(err) && err.response?.data?.error 
          ? err.response.data.error 
          : err instanceof Error 
            ? err.message 
            : 'An error occurred';
      setError(errorMessage);
      
      const botMessage: ChatMessageType = {
        id: messages.length + 2,
        type: 'bot',
        text: `Error: ${errorMessage}`,
        timestamp: new Date()
      };
      setMessages(prev => [...prev, botMessage]);
    } finally {
      setLoading(false);
    }
  };

  const formatResults = (results: ChatMessageType['results'], query: string, totalMatches: number): string => {
    if (!results) return '';
    
    const topResults = results.slice(0, 5);
    let text = `Found ${totalMatches} incidents related to "${query}".\n\nTop matches:\n\n`;
    
    topResults.forEach((result, index) => {
      text += `${index + 1}. ${result.title || 'Untitled'} (${result.relevanceScore}% match)\n`;
      if (result.description) {
        text += `   ${result.description.substring(0, 150)}...\n\n`;
      }
    });

    return text;
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 p-4 shadow-sm">
        <h1 className="text-2xl font-bold text-gray-800">AI Incident Search</h1>
        <p className="text-sm text-gray-600 mt-1">Powered by Gemini Embeddings</p>
      </div>

      {/* Chat Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <ChatMessage 
            key={message.id} 
            message={message}
            results={message.results}
          />
        ))}
        {loading && (
          <div className="flex justify-center">
            <div className="bg-gray-200 rounded-lg p-3">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" style={{animationDelay: '0.2s'}}></div>
                <div className="w-2 h-2 bg-gray-600 rounded-full animate-bounce" style={{animationDelay: '0.4s'}}></div>
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="bg-white border-t border-gray-200 p-4 shadow-lg">
        <SearchInput onSubmit={handleSearch} disabled={loading} />
        {error && (
          <div className="mt-2 text-sm text-red-600 bg-red-50 p-3 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
