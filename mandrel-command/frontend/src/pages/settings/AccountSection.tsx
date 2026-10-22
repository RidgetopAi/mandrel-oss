/**
 * Account section — profile identity + security. Every control here is LIVE:
 *   • profile (username / email) → api.users.updateProfile (PUT /api/users/profile)
 *   • change password           → api.users.changePassword (POST /api/users/change-password)
 *   • revoke all sessions       → api.users.revokeSessions (POST /api/users/revoke-sessions)
 * Current values come from the auth profile (AuthContext). Feedback is inline (Alert),
 * not a global antd toast — matches the rebuilt Contexts/Sessions pattern.
 */
import React from 'react';
import {
  Alert,
  Button,
  Field,
  Form,
  Input,
  Modal,
  Text,
} from '../../components/ui';
import { useAuthContext } from '../../contexts/AuthContext';
import { Group, Row } from './parts';
import { PASSWORD_REQUIREMENTS } from './config';
import { useChangePassword, useRevokeSessions, useUpdateProfile } from './hooks';
import styles from './Settings.module.css';
import { apiErrorMessage } from '../../api/request';

const ChangePasswordModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const mutation = useChangePassword();
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setLocalError(null);
      mutation.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (next !== confirm) {
      setLocalError('New passwords do not match.');
      return;
    }
    mutation.mutate({ currentPassword: current, newPassword: next }, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Change password"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" form="change-password-form" loading={mutation.isPending}>
            Change password
          </Button>
        </>
      }
    >
      <Form id="change-password-form" onSubmit={submit}>
        {(localError || mutation.isError) && (
          <Alert variant="error" title="Couldn't change password">
            {localError ?? apiErrorMessage(mutation.error, 'Password change failed.')}
          </Alert>
        )}
        <div className={styles.pwReq}>
          <Text variant="label" tone="faint">
            Password must contain:
          </Text>
          <ul className={styles.pwReqList}>
            {PASSWORD_REQUIREMENTS.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
        <Field label="Current password">
          <Input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="New password">
          <Input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Field label="Confirm new password">
          <Input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
      </Form>
    </Modal>
  );
};

const RevokeSessionsModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const mutation = useRevokeSessions();

  React.useEffect(() => {
    if (open) mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const confirm = () => {
    mutation.mutate(undefined, {
      onSuccess: () => {
        // Server invalidated every session — send the user back to login.
        localStorage.removeItem('aidis_token');
        window.location.href = '/login';
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Revoke all sessions"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} loading={mutation.isPending}>
            Revoke all &amp; sign out
          </Button>
        </>
      }
    >
      {mutation.isError && (
        <Alert variant="error" title="Couldn't revoke sessions">
          {apiErrorMessage(mutation.error, 'Revoke failed.')}
        </Alert>
      )}
      <Text variant="body" tone="faint">
        This signs you out on every device and session. You&apos;ll need to log in again.
      </Text>
    </Modal>
  );
};

export const AccountSection: React.FC = () => {
  const { user } = useAuthContext();
  const profile = useUpdateProfile();

  const [username, setUsername] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [pwOpen, setPwOpen] = React.useState(false);
  const [revokeOpen, setRevokeOpen] = React.useState(false);

  // Re-auth: the backend requires `currentPassword` whenever an identity
  // field actually changes, and answers 401 REAUTH_REQUIRED without it. So the save is a
  // two-step: collect the change, then confirm the human. Held in state only until the
  // mutation is fired, then cleared — never persisted, never logged.
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const pendingUpdates = React.useRef<{ username?: string; email?: string }>({});

  // Seed the form from the loaded profile; re-seed if the user changes.
  React.useEffect(() => {
    setUsername(user?.username ?? '');
    setEmail(user?.email ?? '');
  }, [user?.username, user?.email]);

  const dirty = username !== (user?.username ?? '') || email !== (user?.email ?? '');

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    const updates: { username?: string; email?: string } = {};
    if (username !== user?.username) updates.username = username;
    if (email !== user?.email) updates.email = email;
    if (Object.keys(updates).length === 0) return;
    // Nothing is sent yet — a real change needs the password step below.
    pendingUpdates.current = updates;
    setConfirmPassword('');
    profile.reset();
    setConfirmOpen(true);
  };

  const confirmSave = (e: React.FormEvent) => {
    e.preventDefault();
    profile.mutate(
      { ...pendingUpdates.current, currentPassword: confirmPassword },
      {
        onSuccess: () => {
          pendingUpdates.current = {};
          setConfirmPassword('');
          setConfirmOpen(false);
        },
      },
    );
  };

  return (
    <>
      <Group title="Profile" description="Your identity in Command — how you appear across sessions.">
        <form id="profile-form" onSubmit={saveProfile}>
          {profile.isError && !confirmOpen && (
            <div className={styles.rowInset}>
              <Alert variant="error" title="Couldn't save profile">
                {apiErrorMessage(profile.error, 'Save failed.')}
              </Alert>
            </div>
          )}
          {profile.isSuccess && !dirty && (
            <div className={styles.rowInset}>
              <Alert variant="success">Profile saved.</Alert>
            </div>
          )}
          <Row label="Username" help="Must be unique.">
            <Input
              className={styles.controlInput}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-label="Username"
              autoComplete="username"
            />
          </Row>
          <Row label="Email" help="Used for account notices.">
            <Input
              className={styles.controlInput}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-label="Email"
              autoComplete="email"
            />
          </Row>
          <div className={styles.rowActions}>
            <Button type="submit" loading={profile.isPending} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </form>
      </Group>

      <Group title="Security" description="Password and active sessions.">
        <Row label="Password" help="Rotate your login password.">
          <Button variant="ghost" onClick={() => setPwOpen(true)}>
            Change password…
          </Button>
        </Row>
        <Row
          label="Active sessions"
          help="Sign out everywhere — useful if a device was lost."
        >
          <Button variant="danger" onClick={() => setRevokeOpen(true)}>
            Revoke all sessions…
          </Button>
        </Row>
      </Group>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm it's you"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={profile.isPending}>
              Cancel
            </Button>
            <Button type="submit" form="confirm-profile-form" loading={profile.isPending}>
              Save changes
            </Button>
          </>
        }
      >
        <form id="confirm-profile-form" onSubmit={confirmSave}>
          <Text>
            Enter your current password to change your username or email. This keeps a stolen
            session from being enough to take over your account.
          </Text>
          {profile.isError && (
            <Alert variant="error" title="Couldn't save profile">
              {apiErrorMessage(profile.error, 'Save failed.')}
            </Alert>
          )}
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-label="Current password"
            autoComplete="current-password"
          />
        </form>
      </Modal>

      <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
      <RevokeSessionsModal open={revokeOpen} onClose={() => setRevokeOpen(false)} />
    </>
  );
};

export default AccountSection;
