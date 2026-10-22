/**
 * useAuthedImage — an `<img src>` for a bearer-authed image.
 *
 * `GET /api/attachments/:id` requires the Authorization header, and an `<img>` tag cannot
 * send one. The two ways round that are a token in the query string (NEVER — it lands in
 * access logs, browser history and Referer headers) or fetching the bytes through the
 * shared axios instance and handing the tag an object URL. This is the second one.
 *
 * Three states, told apart (C1): `loading` / `src` set / `error`. The object URL is revoked
 * when the id changes or the component unmounts, so a gallery that pages through images
 * does not leak a blob per image.
 */
import React from 'react';
import { api } from '../api';

export interface AuthedImage {
  src: string | undefined;
  loading: boolean;
  error: unknown;
}

export function useAuthedImage(attachmentId: string | null | undefined): AuthedImage {
  const [state, setState] = React.useState<AuthedImage>({
    src: undefined,
    loading: Boolean(attachmentId),
    error: null,
  });

  React.useEffect(() => {
    if (!attachmentId) {
      setState({ src: undefined, loading: false, error: null });
      return undefined;
    }
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ src: undefined, loading: true, error: null });
    api.attachments
      .blob(attachmentId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ src: undefined, loading: false, error: err });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachmentId]);

  return state;
}

export default useAuthedImage;
