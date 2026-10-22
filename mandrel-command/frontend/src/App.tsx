import React, { Suspense } from 'react';
import { lazyWithRetry } from './utils/lazyWithRetry';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ConfigProvider } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { globalQueryErrorHandler } from './hooks/useQueryErrorHandler';
import { AuthProvider } from './contexts/AuthContext';
import { ProjectProvider } from './contexts/ProjectContext';
import { SettingsProvider } from './contexts/SettingsContext';
import { FeatureFlagProvider } from './contexts/FeatureFlagContext';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { SseProvider } from './contexts/SseContext';
import ProtectedRoute from './components/ProtectedRoute';
import { AppShell } from './components/shell';
import GlobalErrorBoundary from './components/error/GlobalErrorBoundary';
import SectionErrorBoundary from './components/error/SectionErrorBoundary';
import MandrelApiErrorBoundary from './components/error/MandrelApiErrorBoundary';
import LoadingState from './components/common/LoadingState';
import './App.css';

const Login = lazyWithRetry(() => import('./pages/Login'));
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const Contexts = lazyWithRetry(() => import('./pages/Contexts'));
const Tasks = lazyWithRetry(() => import('./pages/Tasks'));
const Punch = lazyWithRetry(() => import('./pages/Punch'));
const Decisions = lazyWithRetry(() => import('./pages/Decisions'));
const DecisionInbox = lazyWithRetry(() => import('./pages/DecisionInbox'));
const ResolveRedirectPage = lazyWithRetry(() => import('./pages/ResolveRedirectPage'));
const Embedding = lazyWithRetry(() => import('./pages/Embedding'));
const Projects = lazyWithRetry(() => import('./pages/Projects'));
const ProjectDetail = lazyWithRetry(() => import('./pages/ProjectDetail'));
const Sessions = lazyWithRetry(() => import('./pages/Sessions'));
const Calendar = lazyWithRetry(() => import('./pages/Calendar'));
const SessionDetail = lazyWithRetry(() => import('./pages/SessionDetail'));
const Analytics = lazyWithRetry(() => import('./pages/Analytics'));
const TreeWalker = lazyWithRetry(() => import('./pages/TreeWalker'));
const Settings = lazyWithRetry(() => import('./pages/Settings'));
const Profile = lazyWithRetry(() => import('./pages/Profile'));
const Feedback = lazyWithRetry(() => import('./pages/Feedback'));
// P0.3 primitive-library verification surface. Public, standalone (no auth, out
// of the app nav) so the design language can be browser-verified in dev; lazy so
// it stays in its own chunk and is never loaded unless visited.
const PrimitivesGallery = lazyWithRetry(() => import('./pages/PrimitivesGallery'));

// React Query client configuration
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      gcTime: 1000 * 60 * 10, // 10 minutes (formerly cacheTime)
      retry: (failureCount, error: any) => {
        // Don't retry on 4xx errors (client errors)
        if (error?.status >= 400 && error?.status < 500) {
          return false;
        }
        // Retry up to 3 times for other errors
        return failureCount < 3;
      },
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: false, // Don't retry mutations by default
      onError: globalQueryErrorHandler,
    },
  },
});

// Inner App component that uses the theme
const AppContent: React.FC = () => {
  const { antdThemeConfig } = useTheme();

  return (
    <ConfigProvider theme={antdThemeConfig}>
      <QueryClientProvider client={queryClient}>
        <GlobalErrorBoundary>
          <Router>
            <AuthProvider>
              <SettingsProvider>
              <FeatureFlagProvider>
              <MandrelApiErrorBoundary
                componentName="ProjectProvider"
                enableAutoRetry={true}
                maxRetries={3}
              >
                <ProjectProvider>
                  <Suspense fallback={<LoadingState fullscreen message="Preparing Mandrel interface…" /> }>
                    <Routes>
                    {/* Public Routes */}
                    <Route path="/login" element={<SectionErrorBoundary section="Login"><Login /></SectionErrorBoundary>} />

                    {/* Protected Routes */}
                    <Route
                      path="/*"
                      element={
                        <ProtectedRoute>
                          <SseProvider>
                            <AppShell />
                          </SseProvider>
                        </ProtectedRoute>
                      }
                    >
                      {/* Nested protected routes within the layout */}
                      <Route index element={<Navigate to="/dashboard" replace />} />
                      <Route path="dashboard" element={<SectionErrorBoundary section="Dashboard"><Dashboard /></SectionErrorBoundary>} />
                      <Route path="calendar" element={<SectionErrorBoundary section="Calendar"><Calendar /></SectionErrorBoundary>} />
                      {/* TreeWalker (moat graph visualizer) — full UI live; thread data
                          renders honest-empty until the backend endpoint ships. */}
                      <Route path="treewalker" element={<SectionErrorBoundary section="TreeWalker"><TreeWalker /></SectionErrorBoundary>} />
                      <Route path="contexts" element={<SectionErrorBoundary section="Contexts"><Contexts /></SectionErrorBoundary>} />
                      {/* The wide-reader Contexts screen IS the deep-link target: `:id`
                          pre-selects the reader pane (the /r/:id resolve flow lands here). */}
                      <Route path="contexts/:id" element={<SectionErrorBoundary section="Context Detail"><Contexts /></SectionErrorBoundary>} />
                      <Route path="tasks" element={<SectionErrorBoundary section="Tasks"><Tasks /></SectionErrorBoundary>} />
                      {/* The live-thread Tasks screen IS the deep-link target: `:id`
                          pre-selects the task-thread detail (the /r/:id resolve flow lands here). */}
                      <Route path="tasks/:id" element={<SectionErrorBoundary section="Task Detail"><Tasks /></SectionErrorBoundary>} />
                      {/* Punch List: the board, the file-a-punch form, and
                          the punch detail — one screen, layout decided by viewport width. */}
                      <Route path="punch" element={<SectionErrorBoundary section="Punch List"><Punch /></SectionErrorBoundary>} />
                      <Route path="punch/new" element={<SectionErrorBoundary section="Punch List"><Punch /></SectionErrorBoundary>} />
                      <Route path="punch/:id" element={<SectionErrorBoundary section="Punch Detail"><Punch /></SectionErrorBoundary>} />
                      <Route path="decisions" element={<SectionErrorBoundary section="Decisions"><Decisions /></SectionErrorBoundary>} />
                      {/* The answer-fast inbox — a static
                          segment, so it ranks above the `:id` deep-link route below under
                          react-router v6's path-specificity scoring either way. */}
                      <Route path="decisions/inbox" element={<SectionErrorBoundary section="Decision Inbox"><DecisionInbox /></SectionErrorBoundary>} />
                      {/* The why-ledger Decisions screen IS the deep-link target: `:id`
                          pre-selects the reader pane (the /r/:id resolve flow lands here). */}
                      <Route path="decisions/:id" element={<SectionErrorBoundary section="Decision Detail"><Decisions /></SectionErrorBoundary>} />
                      <Route path="r/:id" element={<SectionErrorBoundary section="Resolve Link"><ResolveRedirectPage /></SectionErrorBoundary>} />
                      <Route path="embedding" element={<SectionErrorBoundary section="Embedding"><Embedding /></SectionErrorBoundary>} />
                      <Route path="projects" element={<SectionErrorBoundary section="Projects"><Projects /></SectionErrorBoundary>} />
                      <Route path="projects/:id" element={<SectionErrorBoundary section="Project Detail"><ProjectDetail /></SectionErrorBoundary>} />
                      <Route path="sessions" element={<SectionErrorBoundary section="Sessions"><Sessions /></SectionErrorBoundary>} />
                      <Route path="sessions/:id" element={<SectionErrorBoundary section="Session Detail"><SessionDetail /></SectionErrorBoundary>} />
                      <Route path="analytics" element={<SectionErrorBoundary section="Analytics"><Analytics /></SectionErrorBoundary>} />
                      <Route path="settings" element={<SectionErrorBoundary section="Settings"><Settings /></SectionErrorBoundary>} />
                      <Route path="profile" element={<SectionErrorBoundary section="Profile"><Profile /></SectionErrorBoundary>} />
                      <Route path="feedback" element={<SectionErrorBoundary section="Feedback"><Feedback /></SectionErrorBoundary>} />

                      {/* Catch all - redirect to dashboard */}
                      <Route path="*" element={<Navigate to="/dashboard" replace />} />
                    </Route>
                    </Routes>
                  </Suspense>
                </ProjectProvider>
              </MandrelApiErrorBoundary>
            </FeatureFlagProvider>
              </SettingsProvider>
            </AuthProvider>
        </Router>
      </GlobalErrorBoundary>
      </QueryClientProvider>
    </ConfigProvider>
  );
};

// Main App component with ThemeProvider
const App: React.FC = () => {
  // P0.3 primitive-library verification surface. Rendered fully STANDALONE
  // (before the auth/project/router provider tree) so it is reachable in dev
  // with NO backend, NO auth and NO app chrome — it renders purely on the P0.2
  // token layer (imported globally in index.tsx). Load it directly at /dev/ui.
  // It manages its own theme via `data-theme`, so ThemeProvider isn't needed.
  if (typeof window !== 'undefined' && window.location.pathname === '/dev/ui') {
    return (
      <Suspense fallback={<LoadingState fullscreen message="Loading primitives…" />}>
        <PrimitivesGallery />
      </Suspense>
    );
  }

  return (
    <ThemeProvider>
      <AppContent />
    </ThemeProvider>
  );
};

export default App;