/**
 * TreeWalker in-page navigation targets. Each returns a `to` for react-router's <Link> that
 * keeps the current path and every other query param (`project`, …) and only moves the
 * TreeWalker state (`view` / `anchor` / `record`) — so a Why or Story view stays linkable.
 */
import type { To } from 'react-router-dom';
import { STORY_VIEW_ID, URL_PARAMS, WHY_VIEW_ID } from './config';

/** Open the Why view for a record. */
export function whyTo(current: URLSearchParams, recordId: string): To {
  const next = new URLSearchParams(current);
  next.set(URL_PARAMS.view, WHY_VIEW_ID);
  next.set(URL_PARAMS.record, recordId);
  return { search: `?${next.toString()}` };
}

/** Open the Story view on a branch (the spine id), leaving any Why record behind. */
export function storyTo(current: URLSearchParams, spineId: string): To {
  const next = new URLSearchParams(current);
  next.set(URL_PARAMS.view, STORY_VIEW_ID);
  next.set(URL_PARAMS.anchor, spineId);
  next.delete(URL_PARAMS.record);
  return { search: `?${next.toString()}` };
}

/** Open the Story view scrolled to one beat (a Timeline marker click). */
export function storyBeatTo(current: URLSearchParams, beatId: string): To {
  const next = new URLSearchParams(current);
  next.set(URL_PARAMS.view, STORY_VIEW_ID);
  next.set(URL_PARAMS.beat, beatId);
  next.delete(URL_PARAMS.record);
  return { search: `?${next.toString()}` };
}
