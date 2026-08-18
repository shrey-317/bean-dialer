import '@testing-library/jest-dom/vitest';
// Dexie needs a real IndexedDB implementation; jsdom does not ship one.
import 'fake-indexeddb/auto';
