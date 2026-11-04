import { makeStore } from './app';
const store = makeStore();
store.initialize().then(() => store.close()).catch(error => { console.error(error instanceof Error ? error.message : 'Migration failed'); process.exitCode = 1; });
