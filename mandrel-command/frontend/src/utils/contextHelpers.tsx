import React from 'react';
import { splitOnTerm } from './highlightMatch';
import { highlightConfig } from '../config/highlight';
import '../styles/searchHighlight.css';

export const getTypeDisplayName = (type: string): string => {
  const typeMap: Record<string, string> = {
    code: 'Code',
    decision: 'Decision',
    error: 'Error',
    discussion: 'Discussion',
    planning: 'Planning',
    completion: 'Completion',
  };
  return typeMap[type] || type;
};

export const getTypeColor = (type: string): string => {
  const colorMap: Record<string, string> = {
    code: '#1890ff',
    decision: '#722ed1',
    error: '#ff4d4f',
    discussion: '#13c2c2',
    planning: '#52c41a',
    completion: '#fa8c16',
  };
  return colorMap[type] || '#8c8c8c';
};

export const truncateContent = (content: string, maxLength = 150): string => {
  if (content.length <= maxLength) {
    return content;
  }
  return `${content.substring(0, maxLength).trim()}...`;
};

/**
 * Safe search term highlighting that returns React nodes instead of HTML strings
 * (prevents XSS from dangerouslySetInnerHTML). Reuses the SINGLE source of highlight
 * matching (utils/highlightMatch.splitOnTerm) shared with the detail views and the
 * markdown pipeline, so list-card excerpts and opened records highlight identically
 * (a past incident — no drifting second matcher). Style comes from the shared
 * searchHighlight.css `<mark>`/.ra-search-highlight rule (accessible on dark theme),
 * not an inline color.
 */
export const highlightSearchTermsAsNodes = (
  text: string,
  searchTerm?: string
): React.ReactNode => {
  const slices = splitOnTerm(text, searchTerm);
  // Clean no-op: blank term or no match → the plain string.
  if (slices.length === 1 && !slices[0].match) {
    return text;
  }
  return slices.map((slice, i) =>
    slice.match ? (
      <mark key={i} className={highlightConfig.markClassName}>
        {slice.text}
      </mark>
    ) : (
      <span key={i}>{slice.text}</span>
    )
  );
};

