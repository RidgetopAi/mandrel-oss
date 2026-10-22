import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import LoadingState from './common/LoadingState';
import ForcePasswordChange from '../pages/ForcePasswordChange';

interface ProtectedRouteProps {
  children: React.ReactNode;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading, user } = useAuthContext();
  const location = useLocation();

  if (isLoading) {
    return <LoadingState fullscreen message="Authenticating session…" />;
  }

  if (!isAuthenticated) {
    // Redirect to login page with return url
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // First-login force-password-change gate (new provisions only). The flag comes
  // from the freshly-fetched profile; existing/grandfathered admins have it false
  // and pass straight through. While set, the entire app is blocked behind the
  // forced change screen — no in-app navigation is possible until it clears.
  if (user?.must_change_password) {
    return <ForcePasswordChange />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;
