import { Injectable, Logger } from '@nestjs/common';
import { Parser } from 'json2csv';
import * as fs from 'fs';
import * as path from 'path';

export interface CsvExportOptions {
  filename: string;
  fields?: string[];
  headers?: Record<string, string>;
}

@Injectable()
export class CsvExporterService {
  private readonly logger = new Logger(CsvExporterService.name);
  private readonly storageDir: string;

  constructor() {
    this.storageDir = process.env.REPORTS_STORAGE_PATH || './storage/reports';
    this.ensureStorageDir();
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      this.logger.log(`Created reports storage directory: ${this.storageDir}`);
    }
  }

  /**
   * Export data to CSV file
   * @param data Array of objects to export
   * @param options Export options including filename and field mappings
   * @returns Object with file path and metadata
   */
  async exportToCsv<T extends Record<string, unknown>>(
    data: T[],
    options: CsvExportOptions,
  ): Promise<{ filePath: string; rowCount: number; fileSize: number }> {
    const { filename, fields, headers } = options;

    try {
      // Generate unique filename with timestamp
      const timestamp = Date.now();
      const safeFilename = filename.replace(/[^a-zA-Z0-9-_]/g, '_');
      const fullFilename = `${safeFilename}_${timestamp}.csv`;
      const filePath = path.join(this.storageDir, fullFilename);

      // Configure parser options
      const parserOptions: {
        fields?: { label: string; value: string }[];
        header: boolean;
      } = {
        header: true,
      };

      // Map fields with custom headers if provided
      if (fields) {
        parserOptions.fields = fields.map((field) => ({
          label: headers?.[field] || this.formatFieldName(field),
          value: field,
        }));
      }

      // Parse data to CSV
      const parser = new Parser(parserOptions);
      const csv = parser.parse(data);

      // Write to file
      await fs.promises.writeFile(filePath, csv, 'utf8');

      // Get file stats
      const stats = await fs.promises.stat(filePath);

      this.logger.log(
        `CSV exported: ${fullFilename} (${data.length} rows, ${stats.size} bytes)`,
      );

      return {
        filePath,
        rowCount: data.length,
        fileSize: stats.size,
      };
    } catch (error) {
      this.logger.error(`Failed to export CSV: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Format field name to human-readable header
   * e.g., "student_name" -> "Student Name"
   */
  private formatFieldName(field: string): string {
    return field
      .replace(/_/g, ' ')
      .replace(/([A-Z])/g, ' $1')
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .trim();
  }

  /**
   * Delete a report file
   */
  async deleteFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
        this.logger.log(`Deleted report file: ${filePath}`);
      }
    } catch (error) {
      this.logger.error(`Failed to delete file: ${(error as Error).message}`);
    }
  }

  /**
   * Get file as buffer for download
   */
  async getFileBuffer(filePath: string): Promise<Buffer> {
    return fs.promises.readFile(filePath);
  }

  /**
   * Clean up old report files (older than retention days)
   */
  async cleanupOldReports(retentionDays: number = 7): Promise<number> {
    const cutoffDate = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deletedCount = 0;

    try {
      const files = await fs.promises.readdir(this.storageDir);

      for (const file of files) {
        const filePath = path.join(this.storageDir, file);
        const stats = await fs.promises.stat(filePath);

        if (stats.mtimeMs < cutoffDate) {
          await fs.promises.unlink(filePath);
          deletedCount++;
        }
      }

      if (deletedCount > 0) {
        this.logger.log(`Cleaned up ${deletedCount} old report files`);
      }

      return deletedCount;
    } catch (error) {
      this.logger.error(
        `Failed to cleanup old reports: ${(error as Error).message}`,
      );
      return 0;
    }
  }
}
