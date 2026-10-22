/**
 * File analysis utilities for git service
 * Pure functions for categorizing and analyzing file changes
 */

/**
 * Get file extension from path
 */
export function getFileExtension(filePath: string): string | null {
  const match = filePath.match(/\.([^.]+)$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Categorize file type based on extension
 */
export function categorizeFile(filePath: string): string {
  const ext = getFileExtension(filePath);
  
  if (!ext) return 'unknown';
  
  const categories: Record<string, string[]> = {
    'source': ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt'],
    'web': ['html', 'css', 'scss', 'sass', 'less'],
    'config': ['json', 'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'env'],
    'documentation': ['md', 'rst', 'txt', 'adoc'],
    'data': ['sql', 'csv', 'xml', 'graphql'],
    'image': ['png', 'jpg', 'jpeg', 'gif', 'svg', 'ico'],
    'archive': ['zip', 'tar', 'gz', 'rar'],
    'executable': ['exe', 'dll', 'so', 'dylib']
  };
  
  for (const [category, extensions] of Object.entries(categories)) {
    if (extensions.includes(ext)) {
      return category;
    }
  }
  
  return 'other';
}

/**
 * Calculate change magnitude based on insertions and deletions
 */
export function calculateChangeMagnitude(insertions: number, deletions: number): string {
  const total = insertions + deletions;
  
  if (total === 0) return 'none';
  if (total <= 5) return 'minimal';
  if (total <= 25) return 'small';
  if (total <= 100) return 'medium';
  if (total <= 500) return 'large';
  return 'massive';
}

/**
 * Check if file is a configuration file
 */
export function isConfigurationFile(filePath: string): boolean {
  const configPatterns = [
    /\.config\.(js|ts|json)$/,
    /^\.(env|gitignore|dockerignore|eslintrc|prettierrc)/,
    /package\.json$/,
    /tsconfig\.json$/,
    /webpack\.config/,
    /babel\.config/,
    /jest\.config/,
    /tailwind\.config/,
    /vite\.config/,
    /rollup\.config/,
    /dockerfile$/i,
    /docker-compose/,
    /\.ya?ml$/
  ];
  
  return configPatterns.some(pattern => pattern.test(filePath.toLowerCase()));
}

/**
 * Check if file is documentation
 */
export function isDocumentationFile(filePath: string): boolean {
  const docPatterns = [
    /\.(md|rst|txt|adoc)$/,
    /readme/i,
    /changelog/i,
    /license/i,
    /contributing/i,
    /^docs\//,
    /\.docs\./
  ];
  
  return docPatterns.some(pattern => pattern.test(filePath.toLowerCase()));
}

/**
 * Check if file is a test file
 */
export function isTestFile(filePath: string): boolean {
  const testPatterns = [
    /\.(test|spec)\.(js|ts|jsx|tsx|py|java|cpp|cs|go|rs|php|rb)$/,
    /^tests?\//,
    /__tests__\//,
    /\.test\./,
    /\.spec\./,
    /test_.*\.(py|rb|php)$/,
    /.*_test\.(go|rs|cpp)$/
  ];
  
  return testPatterns.some(pattern => pattern.test(filePath.toLowerCase()));
}

/**
 * Check if file is generated/build output
 */
export function isGeneratedFile(filePath: string): boolean {
  const generatedPatterns = [
    /\.min\.(js|css)$/,
    /\.(map|d\.ts)$/,
    /^dist\//,
    /^build\//,
    /^node_modules\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /^coverage\//,
    /\.generated\./,
    /auto-generated/i,
    /generated/i,
    /^target\//,  // Java/Scala build output
    /^bin\//,     // Compiled binaries
    /^out\//      // TypeScript/C# output
  ];
  
  return generatedPatterns.some(pattern => pattern.test(filePath));
}

/**
 * Detect programming language from file path
 */
export function detectProgrammingLanguage(filePath: string): string | null {
  const ext = getFileExtension(filePath);
  
  if (!ext) return null;
  
  const languageMap: Record<string, string> = {
    'js': 'JavaScript',
    'jsx': 'JavaScript',
    'ts': 'TypeScript',
    'tsx': 'TypeScript',
    'py': 'Python',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'cs': 'C#',
    'go': 'Go',
    'rs': 'Rust',
    'php': 'PHP',
    'rb': 'Ruby',
    'swift': 'Swift',
    'kt': 'Kotlin',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'sass': 'Sass',
    'less': 'Less',
    'sql': 'SQL',
    'sh': 'Shell',
    'bash': 'Bash',
    'yml': 'YAML',
    'yaml': 'YAML',
    'json': 'JSON',
    'xml': 'XML',
    'graphql': 'GraphQL'
  };
  
  return languageMap[ext] || null;
}

/**
 * Analyze file change characteristics
 */
export function analyzeFileChange(filePath: string, stats: { insertions?: number; deletions?: number; is_binary?: boolean }): {
  file_extension: string | null;
  file_category: string;
  change_magnitude: string;
  is_configuration: boolean;
  is_documentation: boolean;
  is_test: boolean;
  language: string | null;
} {
  return {
    file_extension: getFileExtension(filePath),
    file_category: categorizeFile(filePath),
    change_magnitude: calculateChangeMagnitude(stats.insertions || 0, stats.deletions || 0),
    is_configuration: isConfigurationFile(filePath),
    is_documentation: isDocumentationFile(filePath),
    is_test: isTestFile(filePath),
    language: detectProgrammingLanguage(filePath)
  };
}

/**
 * Calculate file risk score based on change patterns
 */
export function calculateFileRiskScore(
  changeCount: number,
  contributorCount: number,
  avgChangeSize: number,
  lastChanged: Date
): number {
  let riskScore = 0;
  
  // High change frequency increases risk
  if (changeCount > 10) riskScore += 0.3;
  if (changeCount > 25) riskScore += 0.2;
  if (changeCount > 50) riskScore += 0.2;
  
  // Many contributors can indicate complexity
  if (contributorCount > 5) riskScore += 0.2;
  if (contributorCount > 10) riskScore += 0.1;
  
  // Large average changes suggest complexity
  if (avgChangeSize > 50) riskScore += 0.2;
  if (avgChangeSize > 200) riskScore += 0.2;
  
  // Recent activity suggests ongoing work
  const daysSinceLastChange = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastChange < 7) riskScore += 0.1;
  
  return Math.min(Math.round(riskScore * 100) / 100, 1.0);
}
