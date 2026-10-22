/**
 * Productivity calculation functions
 * Pure functions for computing productivity scores
 */

import type { SessionData } from '../../types.js';

/**
 * Calculate basic productivity score
 * Formula: (contexts*2 + decisions*3) / (hours + 1)
 */
export function calculateBasicProductivity(sessionData: SessionData): number {
  const contextsWeight = sessionData.contexts_created * 2;
  const decisionsWeight = sessionData.decisions_created * 3;
  const durationHours = (sessionData.duration_ms || 0) / (1000 * 60 * 60) || 1;

  const productivity = (contextsWeight + decisionsWeight) / (durationHours + 1);

  return Math.round(productivity * 100) / 100;
}

/**
 * Calculate weighted productivity score using custom weights
 */
export function calculateWeightedProductivity(
  sessionData: SessionData,
  weights: Record<string, number>
): number {
  let score = 0;
  let totalWeight = 0;

  // Tasks component
  if (weights.tasks !== undefined) {
    const tasksCompleted = sessionData.contexts_created || 0;
    score += weights.tasks * tasksCompleted * 10;
    totalWeight += weights.tasks;
  }

  // Context component
  if (weights.context !== undefined) {
    const contextsCreated = sessionData.contexts_created || 0;
    score += weights.context * contextsCreated * 10;
    totalWeight += weights.context;
  }

  // Decisions component
  if (weights.decisions !== undefined) {
    const decisionsCreated = sessionData.decisions_created || 0;
    score += weights.decisions * decisionsCreated * 15;
    totalWeight += weights.decisions;
  }

  // LOC component
  if (weights.loc !== undefined) {
    const linesNet = sessionData.lines_net || 0;
    const locScore = linesNet > 0 ? linesNet / 10 : linesNet / 20;
    score += weights.loc * locScore;
    totalWeight += weights.loc;
  }

  // Time component (efficiency)
  if (weights.time !== undefined && sessionData.duration_ms) {
    const hours = sessionData.duration_ms / (1000 * 60 * 60);
    const timeEfficiency = totalWeight > 0 ? score / (hours + 1) : 0;
    score = score * (1 + weights.time * (timeEfficiency / 100));
  }

  // Normalize to 0-100 scale
  const finalScore = Math.min(Math.max(score, 0), 100);
  return Math.round(finalScore * 100) / 100;
}
