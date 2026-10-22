import React from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Empty, Spin, Button, Card, List, Tag, Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { resolveNavRecord, type NavCandidate } from '../api/resolveClient';

const { Text, Paragraph } = Typography;

/**
 * Navigation landing route: `/r/:id`.
 *
 * This is where an in-text id link (Feature C linkify) and any short `/r/<id>` link
 * (the coordinator's short links / the backend 302's SPA target) land. It resolves the bare id
 * via GET /api/resolve/:id and then:
 *   - unique     → client-side navigate() to the typed detail page (SAME tab), replacing
 *                  this entry in history so Back returns to the source, not here.
 *   - ambiguous  → render the candidate list; the user picks (we NEVER auto-pick).
 *   - not-found  → a clean not-found (unknown / unresolvable id — never a wrong jump).
 *   - invalid    → same clean not-found (a malformed id can't resolve to a record).
 *
 * All navigation is client-side (react-router) so a record opens in the current tab.
 */
const ResolveRedirectPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['resolveNav', id],
    queryFn: () => resolveNavRecord(id as string),
    enabled: !!id,
    retry: false,
  });

  // On a unique match, perform the client-side navigation (replace history so Back
  // does not bounce through this resolver page).
  React.useEffect(() => {
    if (data?.status === 'unique') {
      navigate(data.record.url, { replace: true });
    }
  }, [data, navigate]);

  // Resolving, or about to redirect on a unique match.
  if (!id || isLoading || data?.status === 'unique') {
    return (
      <div style={{ textAlign: 'center', padding: '50px' }}>
        <Spin size="large" tip="Resolving link…" />
      </div>
    );
  }

  if (data?.status === 'ambiguous') {
    return (
      <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 16px' }}>
        <Card title={`"${id}" matches ${data.candidates.length} records`}>
          <Paragraph type="secondary">
            This short id is ambiguous. Choose the record you meant:
          </Paragraph>
          <List
            dataSource={data.candidates}
            renderItem={(candidate: NavCandidate) => (
              <List.Item>
                <Link to={candidate.url}>
                  <LinkOutlined /> <Tag>{candidate.type}</Tag>
                  <Text>{candidate.title || candidate.id}</Text>
                </Link>
              </List.Item>
            )}
          />
        </Card>
      </div>
    );
  }

  // notfound | invalid | query error → one clean not-found state, but NOT a blank one:
  // render the backend's own explanation (which record types were searched, whether a
  // project scope narrowed it, or which id-shape rule was broken). The literal sentence
  // that used to live here named three record types and went stale the moment the
  // resolver learned two more — deriving the copy from the response is what stops that
  // recurring. Falls back to a generic line only when there was no body to read.
  const failureMessage =
    (data?.status === 'notfound' || data?.status === 'invalid' ? data.message : undefined) ??
    (isError
      ? 'Could not resolve this link — the resolver could not be reached.'
      : `Nothing matches "${id}".`);

  return (
    <div style={{ textAlign: 'center', padding: '50px' }}>
      <Empty
        description={failureMessage}
        image={<LinkOutlined style={{ fontSize: 64, color: '#ccc' }} />}
      >
        <Button type="primary" onClick={() => navigate('/dashboard')}>
          Back to Dashboard
        </Button>
      </Empty>
    </div>
  );
};

export default ResolveRedirectPage;
