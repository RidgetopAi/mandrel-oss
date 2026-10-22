# Session Management Tests

This directory contains comprehensive tests for AIDIS session functionality.

## Test Files

### `session.e2e.test.ts`
End-to-end tests that validate the complete session management workflow including:
- Session lifecycle (start/end/active detection)
- Project assignment and switching
- Analytics event tracking
- Session productivity calculations
- Error handling and edge cases
- Database integration

### `session.unit.test.ts`
Unit tests for individual functions and methods including:
- SessionTracker class methods
- SessionManagementHandler methods
- Utility functions
- Mock database interactions
- Error handling

## Running Tests

### Prerequisites
```bash
cd mcp-server
npm install
```

### Run All Tests
```bash
npm run test
```

### Run Only Session Tests
```bash
npm run test src/tests/session
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```

### Run E2E Tests Only
```bash
npx vitest run src/tests/session.e2e.test.ts
```

### Run Unit Tests Only
```bash
npx vitest run src/tests/session.unit.test.ts
```

## Test Database Setup

The E2E tests require a PostgreSQL database connection. Make sure you have:

1. PostgreSQL running with the AIDIS database setup
2. Environment variables configured (see `.env` file)
3. Database tables created (run migrations if needed)

The tests will:
- Create temporary test projects
- Use real database transactions
- Clean up all test data automatically

## Test Structure

### E2E Test Coverage
- ✅ New session auto-assignment to project
- ✅ Session creation without project assignment
- ✅ Manual session assignment via tools
- ✅ Session status retrieval
- ✅ Analytics event linking
- ✅ Session operation recording
- ✅ Session data retrieval and metrics
- ✅ Session ending and finalization
- ✅ Custom session creation with titles
- ✅ Error handling for invalid projects
- ✅ Session statistics calculation
- ✅ Active session detection
- ✅ Productivity score calculation

### Unit Test Coverage
- ✅ SessionTracker.startSession()
- ✅ SessionTracker.getActiveSession()
- ✅ SessionTracker.recordOperation()
- ✅ SessionTracker.getSessionData()
- ✅ SessionTracker.calculateProductivity()
- ✅ SessionTracker.sessionExists()
- ✅ SessionTracker.getSessionStats()
- ✅ SessionManagementHandler methods
- ✅ Utility functions
- ✅ Analytics handler utilities
- ✅ Error scenarios and edge cases

## Test Validation Requirements

✅ **Tests cover all critical session functionality**
- Complete session lifecycle
- Project assignment and management
- Analytics tracking and metrics
- Error handling and validation

✅ **Tests cover both happy path and error cases**
- Successful operations
- Invalid input handling
- Database error scenarios
- Missing data handling

✅ **Tests clean up test data properly**
- Automatic cleanup in `afterAll`
- Test isolation between runs
- No interference with production data

✅ **Tests are runnable with Vitest**
- Proper Vitest configuration
- Mock setup for database interactions
- Async test handling

✅ **Tests do not interfere with production data**
- Separate test project creation
- Isolated test transactions
- Complete cleanup procedures

## Debugging Tests

### Verbose Output
```bash
npx vitest run --reporter=verbose src/tests/session
```

### Debug Individual Test
```bash
npx vitest run --reporter=verbose -t "should create new session"
```

### Check Test Coverage
```bash
npx vitest run --coverage src/tests/session
```

## Test Maintenance

- Tests are designed to be robust and maintainable
- Database schemas changes may require test updates
- Mock implementations should match real implementations
- Add new tests when adding new session functionality
