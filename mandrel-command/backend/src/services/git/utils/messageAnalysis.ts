/**
 * Commit message analysis utilities
 * Pure functions for parsing and analyzing git commit messages
 */

import { CommitType } from '../../../types/git';
import { logger } from '../../../config/logger';

/**
 * Classify commit type from message
 */
export function classifyCommitType(message: string): CommitType {
  const msg = message.toLowerCase();
  
  if (msg.match(/^(fix|fixed|fixes|bug)[\s([]/)) return 'fix';
  if (msg.match(/^(feat|feature|add)[\s([]/)) return 'feature';
  if (msg.match(/^(docs|doc)[\s([]/)) return 'docs';
  if (msg.match(/^(refactor|refact)[\s([]/)) return 'refactor';
  if (msg.match(/^(test|tests)[\s([]/)) return 'test';
  if (msg.match(/^(style|format)[\s([]/)) return 'style';
  if (msg.match(/^(chore|build|ci)[\s([]/)) return 'chore';
  if (msg.match(/^(merge|merged)/)) return 'merge';
  
  return 'feature';
}

/**
 * Map conventional commit type to CommitType enum
 */
export function mapConventionalCommitType(conventionalType: string): CommitType {
  const typeMapping: Record<string, CommitType> = {
    'feat': 'feature',
    'fix': 'fix',
    'docs': 'docs',
    'style': 'style',
    'refactor': 'refactor',
    'test': 'test',
    'chore': 'chore',
    'build': 'chore',
    'ci': 'chore',
    'perf': 'refactor',
    'revert': 'fix'
  };
  
  return typeMapping[conventionalType.toLowerCase()] || 'feature';
}

/**
 * Analyze commit message for patterns and metadata
 */
export function analyzeCommitMessage(message: string, body?: string): {
  type: CommitType;
  scope: string | null;
  breaking_change: boolean;
  conventional_commit: boolean;
  tags: string[];
  ticket_references: string[];
  co_authors: Array<{ name: string; email: string }>;
} {
  const analysis = {
    type: 'feature' as CommitType,
    scope: null as string | null,
    breaking_change: false,
    conventional_commit: false,
    tags: [] as string[],
    ticket_references: [] as string[],
    co_authors: [] as Array<{ name: string; email: string }>
  };

  // Check for conventional commit format
  const conventionalMatch = message.match(/^(\w+)(\(([^)]+)\))?(!?):\s*(.+)$/);
  if (conventionalMatch) {
    analysis.conventional_commit = true;
    analysis.type = mapConventionalCommitType(conventionalMatch[1]);
    analysis.scope = conventionalMatch[3] || null;
    analysis.breaking_change = conventionalMatch[4] === '!';
  } else {
    // Fallback to basic classification
    analysis.type = classifyCommitType(message);
  }

  // Check for breaking change indicators
  const fullText = `${message} ${body || ''}`;
  if (fullText.includes('BREAKING CHANGE') || fullText.includes('breaking change')) {
    analysis.breaking_change = true;
  }

  // Extract ticket references (e.g., #123, JIRA-456, closes #789)
  const ticketMatches = fullText.match(/(?:#(\d+)|([A-Z]+-\d+)|(?:closes?|fixes?|resolves?)\s+#(\d+))/gi);
  if (ticketMatches) {
    analysis.ticket_references = [...new Set(ticketMatches.map(match => match.trim()))];
  }

  // Extract co-authors from body
  if (body) {
    const coAuthorMatches = body.match(/Co-authored-by:\s*(.+?)\s*<(.+?)>/gi);
    if (coAuthorMatches) {
      analysis.co_authors = coAuthorMatches.map(match => {
        const authorMatch = match.match(/Co-authored-by:\s*(.+?)\s*<(.+?)>/);
        return authorMatch ? { name: authorMatch[1].trim(), email: authorMatch[2].trim() } : null;
      }).filter((author): author is { name: string; email: string } => author !== null);
    }
  }

  // Add semantic tags
  if (analysis.breaking_change) analysis.tags.push('breaking');
  if (analysis.conventional_commit) analysis.tags.push('conventional');
  if (analysis.ticket_references.length > 0) analysis.tags.push('references-ticket');
  if (analysis.co_authors.length > 0) analysis.tags.push('collaborative');

  return analysis;
}

/**
 * Determine merge strategy from commit message
 */
export function determineMergeStrategy(message: string): string {
  if (message.includes('Squash merge') || message.includes('squash')) return 'squash';
  if (message.includes('Rebase') || message.includes('rebase')) return 'rebase';
  if (message.includes('Fast-forward') || message.includes('fast-forward')) return 'fast-forward';
  return 'merge';
}

/**
 * Parse commit statistics from git show output
 */
export function parseCommitStats(gitShowOutput: string): {
  files_changed: number;
  insertions: number;
  deletions: number;
  file_stats: Array<{
    file_path: string;
    insertions: number;
    deletions: number;
    is_binary: boolean;
  }>;
} {
  const stats = {
    files_changed: 0,
    insertions: 0,
    deletions: 0,
    file_stats: [] as Array<{
      file_path: string;
      insertions: number;
      deletions: number;
      is_binary: boolean;
    }>
  };

  try {
    // Parse shortstat line (e.g., " 3 files changed, 45 insertions(+), 12 deletions(-)")
    const shortstatMatch = gitShowOutput.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (shortstatMatch) {
      stats.files_changed = parseInt(shortstatMatch[1]) || 0;
      stats.insertions = parseInt(shortstatMatch[2]) || 0;
      stats.deletions = parseInt(shortstatMatch[3]) || 0;
    }

    // Parse numstat lines for individual file statistics
    const numstatRegex = /^(\d+|-)\t(\d+|-)\t(.+)$/gm;
    let match;
    while ((match = numstatRegex.exec(gitShowOutput)) !== null) {
      const [, insertions, deletions, filePath] = match;
      stats.file_stats.push({
        file_path: filePath,
        insertions: insertions === '-' ? 0 : parseInt(insertions),
        deletions: deletions === '-' ? 0 : parseInt(deletions),
        is_binary: insertions === '-' && deletions === '-'
      });
    }
  } catch (error) {
    logger.warn('Failed to parse commit stats', { error });
  }

  return stats;
}

/**
 * Extract branch names from refs string
 */
export function extractBranches(refs: string): string[] {
  if (!refs) return [];
  
  return refs.split(', ')
    .filter(ref => !ref.includes('tag:') && !ref.includes('HEAD'))
    .map(ref => ref.replace(/^origin\//, ''));
}
