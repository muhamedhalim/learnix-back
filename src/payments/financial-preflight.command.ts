import { AppDataSource } from '../data-source';
import { formatFinancialPreflightReport, runFinancialPreflight } from './financial-preflight';

/** Read-only operational command: `npm run finance:preflight`. */
async function main(): Promise<void> {
  await AppDataSource.initialize();
  try {
    const report = await runFinancialPreflight(AppDataSource);
    console.log(formatFinancialPreflightReport(report));
    if (!report.valid) process.exitCode = 2;
  } finally {
    await AppDataSource.destroy();
  }
}

void main();
