/**
 * API tokens section — LIVE. The ONLY way a hosted
 * customer gets a token for their Punch List loop (MANDREL_TOKEN) or an MCP client.
 *
 *   • create  → api.apiTokens.create (POST /api/api-tokens) → a show-once modal: the token,
 *               Copy, and "I've stored it". The plaintext lives in THIS component's state
 *               only while that modal is open; the mutation is reset at once so react-query
 *               does not keep it either. Closing the modal drops it for good.
 *   • list    → api.apiTokens.list (GET /api/api-tokens): name, prefix, created, last used.
 *   • revoke  → api.apiTokens.revoke (DELETE /api/api-tokens/:id) behind a confirm modal.
 *
 * ADMIN-ONLY (Reviewer F1): a non-admin sees an explanation instead of the controls, and
 * the list is never requested for them. The server is the authority (403 + the mcp-server's
 * owner-role check); this is presentation.
 *
 * Embeddings stays as a fixed, informational deployment fact (not a live read).
 */
import React from 'react';
import {
  Alert,
  Badge,
  Button,
  Code,
  DataTable,
  Field,
  Input,
  Modal,
  Text,
  type Column,
} from '../../components/ui';
import { apiErrorMessage } from '../../api/request';
import { useAuthContext } from '../../contexts/AuthContext';
import type { ApiToken } from '../../api/domains/apiTokens';
import { formatDateTime, formatRelative } from '../../utils/datetime';
import { Group, Row } from './parts';
import { API_TOKENS_ADMIN_ONLY } from './config';
import { useApiTokens, useCreateApiToken, useRevokeApiToken } from './hooks';
import { LockIcon } from './icons';
import styles from './Settings.module.css';

/** The show-once modal. `token` is the plaintext; nothing else in the app holds it. */
const ShowTokenModal: React.FC<{ token: string | null; name: string; onDone: () => void }> = ({
  token,
  name,
  onDone,
}) => {
  const [copy, setCopy] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => setCopy('idle'), [token]);

  const doCopy = async () => {
    if (!token) return;
    try {
      // navigator.clipboard is absent outside a secure context; fall back to selecting
      // the text so the user can copy it by hand.
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(token);
      setCopy('copied');
    } catch {
      inputRef.current?.select();
      setCopy('failed');
    }
  };

  return (
    <Modal
      open={token !== null}
      onClose={onDone}
      closeOnBackdrop={false}
      title={`Token created: ${name}`}
      footer={<Button onClick={onDone}>I&apos;ve stored it</Button>}
    >
      <Alert variant="warning" title="Copy it now — it will not be shown again">
        Only a hash is kept on the server. If you lose this token, revoke it and create a new one.
      </Alert>
      <Field label="Your token">
        <Input
          ref={inputRef}
          readOnly
          value={token ?? ''}
          aria-label="API token"
          mono
          onFocus={(e) => e.currentTarget.select()}
          className={styles.tokenValue}
        />
      </Field>
      <div className={styles.tokenCopyRow}>
        <Button variant="subtle" onClick={doCopy}>
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </Button>
        {copy === 'failed' && (
          <Text variant="label" tone="faint">
            Couldn&apos;t reach the clipboard — the token is selected; copy it by hand.
          </Text>
        )}
      </div>
      <Text variant="label" tone="faint">
        Set it as <Code>MANDREL_TOKEN</Code> where your Punch List loop runs, or send it as{' '}
        <Code>Authorization: Bearer &lt;token&gt;</Code> from an MCP client.
      </Text>
    </Modal>
  );
};

const RevokeModal: React.FC<{ target: ApiToken | null; onClose: () => void }> = ({ target, onClose }) => {
  const mutation = useRevokeApiToken();

  React.useEffect(() => {
    if (target) mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const confirm = () => {
    if (!target) return;
    mutation.mutate(target.id, { onSuccess: onClose });
  };

  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title="Revoke token"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} loading={mutation.isPending}>
            Revoke
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <Alert variant="error" title="Couldn't revoke the token">
          {apiErrorMessage(mutation.error, 'Revoke failed.')}
        </Alert>
      )}
      <Text>
        Revoke <strong>{target?.name}</strong> (<Code>{target?.prefix}…</Code>)? Anything using it —
        a loop or an MCP client — is refused on its next request. This cannot be undone.
      </Text>
    </Modal>
  );
};

const EmbeddingsGroup: React.FC = () => (
  <Group title="Embeddings">
    <Row label="Embeddings" help="Local Transformers.js — zero cost, nothing leaves the box.">
      <Badge variant="blue">
        <span className={styles.badgeIcon}>
          <LockIcon />
        </span>
        local · on-box
      </Badge>
    </Row>
  </Group>
);

export const ApiTokensSection: React.FC = () => {
  const { user } = useAuthContext();
  const isAdmin = user?.role === 'admin';
  if (!isAdmin) {
    return (
      <>
        <Group title="API tokens" description="Personal tokens for your Punch List loop and MCP clients.">
          <div className={styles.tokenTable}>
            <Alert variant="info" title="Admins only">
              {API_TOKENS_ADMIN_ONLY}
            </Alert>
          </div>
        </Group>
        <EmbeddingsGroup />
      </>
    );
  }
  return <AdminApiTokens />;
};

const AdminApiTokens: React.FC = () => {
  const list = useApiTokens();
  const create = useCreateApiToken();
  const [name, setName] = React.useState('');
  const [shown, setShown] = React.useState<{ token: string; name: string } | null>(null);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiToken | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreateError(null);
    try {
      const created = await create.mutateAsync(trimmed);
      setShown({ token: created.plaintext, name: created.token.name });
      setName('');
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create the token.'));
    } finally {
      // Drop the plaintext from react-query's mutation cache: the modal state is the only holder.
      create.reset();
    }
  };

  const columns: Column<ApiToken>[] = [
    { key: 'name', header: 'Name', render: (t) => t.name },
    { key: 'prefix', header: 'Token', render: (t) => <Code>{t.prefix}…</Code> },
    {
      key: 'createdAt',
      header: 'Created',
      render: (t) => <span title={formatDateTime(t.createdAt)}>{formatRelative(t.createdAt)}</span>,
    },
    {
      key: 'lastUsedAt',
      header: 'Last used',
      render: (t) =>
        t.lastUsedAt ? <span title={formatDateTime(t.lastUsedAt)}>{formatRelative(t.lastUsedAt)}</span> : 'Never',
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (t) => (
        <Button variant="ghost" size="sm" onClick={() => setRevokeTarget(t)} aria-label={`Revoke ${t.name}`}>
          Revoke
        </Button>
      ),
    },
  ];

  return (
    <>
      <Group
        title="API tokens"
        description="Personal tokens for your Punch List loop and MCP clients. Requests made with a token act as you."
      >
        <form onSubmit={submit}>
          <Row label="Create a token" help="Name it after where it will live, e.g. “loop on laptop”.">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name"
              aria-label="Token name"
              maxLength={100}
              className={styles.controlInput}
            />
            <Button type="submit" loading={create.isPending} disabled={!name.trim()}>
              Create token
            </Button>
          </Row>
        </form>
        {createError && (
          <div className={styles.rowInset}>
            <Alert variant="error" title="Couldn't create the token">
              {createError}
            </Alert>
          </div>
        )}
        <div className={styles.tokenTable}>
          {list.isError ? (
            <Alert variant="error" title="Couldn't load your tokens">
              {apiErrorMessage(list.error, 'Loading tokens failed.')}
            </Alert>
          ) : (
            <DataTable
              columns={columns}
              data={list.data ?? []}
              rowKey={(t) => t.id}
              loading={list.isLoading}
              empty="No tokens yet. Create one above."
            />
          )}
        </div>
      </Group>
      <EmbeddingsGroup />
      <ShowTokenModal token={shown?.token ?? null} name={shown?.name ?? ''} onDone={() => setShown(null)} />
      <RevokeModal target={revokeTarget} onClose={() => setRevokeTarget(null)} />
    </>
  );
};

export default ApiTokensSection;
