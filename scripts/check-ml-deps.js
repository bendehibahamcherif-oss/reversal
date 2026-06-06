#!/usr/bin/env node
import fs from 'node:fs';
import { probePythonDependencies, getPythonBin } from '../server/ai/trainingService.js';

const result = await probePythonDependencies({ pythonBin: getPythonBin() });
fs.writeFileSync('ML_DEPENDENCY_CHECK_RESULTS.json', `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
if (!result.ok || result.status !== 'ready') {
  process.exitCode = 1;
}
