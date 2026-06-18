#!/usr/bin/env node

/**
 * Database Restoration Script
 * 
 * This script restores the Supabase database from a backup file.
 * Use with caution - this will overwrite existing data.
 * 
 * Usage:
 *   node scripts/restore-database.js --backup=backup-file.sql
 *   node scripts/restore-database.js --backup=latest
 * 
 * Environment Variables Required:
 *   SUPABASE_URL: Your Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY: Service role key with admin privileges
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const path = require('path');
const { program } = require('commander');

const execAsync = promisify(exec);

program
  .option('-b, --backup <file>', 'Backup file to restore (or "latest")', 'latest')
  .option('-d, --dry-run', 'Dry run - show what would be restored without executing')
  .option('-f, --force', 'Force restore without confirmation')
  .parse(process.argv);

const options = program.opts();

class DatabaseRestore {
  constructor(backupFile, dryRun = false, force = false) {
    this.supabaseUrl = process.env.SUPABASE_URL;
    this.serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    this.backupDir = path.join(process.cwd(), 'backups');
    this.dryRun = dryRun;
    this.force = force;
    
    if (backupFile === 'latest') {
      this.backupFile = this.findLatestBackup();
    } else {
      this.backupFile = backupFile;
    }
    
    this.validateEnvironment();
  }

  validateEnvironment() {
    if (!this.supabaseUrl) {
      throw new Error('SUPABASE_URL environment variable is required');
    }
    if (!this.serviceRoleKey) {
      throw new Error('SUPABASE_SERVICE_ROLE_KEY environment variable is required');
    }
    if (!this.backupFile) {
      throw new Error('Backup file not found');
    }
  }

  findLatestBackup() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(file => file.endsWith('.sql'))
        .map(file => ({
          name: file,
          time: fs.statSync(path.join(this.backupDir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length === 0) {
        throw new Error('No backup files found in backups directory');
      }

      return path.join(this.backupDir, files[0].name);
    } catch (error) {
      console.error('Error finding latest backup:', error.message);
      return null;
    }
  }

  async getBackupInfo() {
    try {
      const stats = await fs.stat(this.backupFile);
      const content = await fs.readFile(this.backupFile, 'utf8');
      
      // Extract metadata from backup file
      const firstLine = content.split('\n')[0];
      const backupDateMatch = firstLine.match(/-- Supabase Backup - (.+)/);
      const backupDate = backupDateMatch ? backupDateMatch[1] : 'Unknown';
      
      const lineCount = content.split('\n').length;
      const size = this.formatFileSize(stats.size);
      
      return {
        filename: path.basename(this.backupFile),
        path: this.backupFile,
        size: size,
        date: backupDate,
        lines: lineCount,
        exists: true
      };
    } catch (error) {
      return {
        filename: this.backupFile,
        exists: false,
        error: error.message
      };
    }
  }

  async confirmRestore(backupInfo) {
    if (this.force) {
      return true;
    }

    console.log('\n=== DATABASE RESTORE CONFIRMATION ===');
    console.log('WARNING: This operation will OVERWRITE your database.');
    console.log('All current data will be replaced with backup data.\n');
    
    console.log('Backup Details:');
    console.log(`  File: ${backupInfo.filename}`);
    console.log(`  Date: ${backupInfo.date}`);
    console.log(`  Size: ${backupInfo.size}`);
    console.log(`  Lines: ${backupInfo.lines}`);
    
    console.log('\nDatabase Details:');
    console.log(`  URL: ${this.supabaseUrl}`);
    
    if (this.dryRun) {
      console.log('\nDRY RUN: No changes will be made.');
      return true;
    }
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    return new Promise((resolve) => {
      readline.question('\nType "RESTORE" to confirm: ', (answer) => {
        readline.close();
        resolve(answer === 'RESTORE');
      });
    });
  }

  async restoreDatabase() {
    console.log('Starting database restoration...');
    
    // Extract database connection details from Supabase URL
    const dbUrl = new URL(this.supabaseUrl);
    const dbHost = dbUrl.hostname;
    const dbName = dbUrl.pathname.split('/').pop();
    
    // Using psql to restore backup
    const restoreCommand = `psql \
      --host=${dbHost} \
      --dbname=${dbName} \
      --username=postgres \
      --no-password \
      --file="${this.backupFile}" \
      --single-transaction \
      --verbose`;
    
    // Set password in environment for psql
    const env = {
      ...process.env,
      PGPASSWORD: this.serviceRoleKey
    };

    try {
      if (this.dryRun) {
        console.log('Dry run - would execute:', restoreCommand);
        return { success: true, dryRun: true };
      }

      console.log('Restoring database (this may take several minutes)...');
      const { stdout, stderr } = await execAsync(restoreCommand, { env, timeout: 300000 }); // 5 minute timeout
      
      if (stderr && !stderr.includes('WARNING')) {
        console.warn('Restoration warnings:', stderr);
      }
      
      console.log('Database restoration completed successfully!');
      console.log(`Restored from: ${this.backupFile}`);
      
      return {
        success: true,
        backupFile: this.backupFile,
        output: stdout.substring(0, 500) + '...' // Truncate for readability
      };
    } catch (error) {
      console.error('Failed to restore database:', error.message);
      
      // Provide recovery suggestions
      if (error.message.includes('connection')) {
        console.log('\nTroubleshooting:');
        console.log('1. Check database connection parameters');
        console.log('2. Verify service role key has admin privileges');
        console.log('3. Ensure database is accessible from this network');
      }
      
      return {
        success: false,
        error: error.message,
        backupFile: this.backupFile
      };
    }
  }

  async verifyRestoration() {
    console.log('\nVerifying restoration...');
    
    // Simple verification by checking if we can connect and run a basic query
    const dbUrl = new URL(this.supabaseUrl);
    const dbHost = dbUrl.hostname;
    const dbName = dbUrl.pathname.split('/').pop();
    
    const verifyCommand = `psql \
      --host=${dbHost} \
      --dbname=${dbName} \
      --username=postgres \
      --no-password \
      --command="SELECT 'Restoration verified at ' || NOW() as verification;"`;
    
    const env = {
      ...process.env,
      PGPASSWORD: this.serviceRoleKey
    };

    try {
      const { stdout } = await execAsync(verifyCommand, { env });
      console.log('Verification successful:', stdout.trim());
      return true;
    } catch (error) {
      console.error('Verification failed:', error.message);
      return false;
    }
  }

  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  async run() {
    console.log('=== Database Restoration Process ===');
    
    try {
      // Get backup information
      const backupInfo = await this.getBackupInfo();
      
      if (!backupInfo.exists) {
        console.error(`Backup file not found: ${backupInfo.filename}`);
        console.log('Available backups:');
        try {
          const files = await fs.readdir(this.backupDir);
          files.filter(f => f.endsWith('.sql')).forEach(f => console.log(`  - ${f}`));
        } catch {
          console.log('  No backups directory found');
        }
        return { success: false, error: 'Backup file not found' };
      }
      
      // Confirm restoration
      const confirmed = await this.confirmRestore(backupInfo);
      if (!confirmed) {
        console.log('Restoration cancelled by user.');
        return { success: false, cancelled: true };
      }
      
      // Perform restoration
      const restoreResult = await this.restoreDatabase();
      if (!restoreResult.success) {
        return restoreResult;
      }
      
      // Verify restoration
      const verified = await this.verifyRestoration();
      
      console.log('\n=== RESTORATION COMPLETE ===');
      console.log('Next steps:');
      console.log('1. Test critical application functions');
      console.log('2. Verify data integrity');
      console.log('3. Monitor application performance');
      console.log('4. Document restoration in incident log');
      
      return {
        success: true,
        verified: verified,
        backup: backupInfo,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      console.error('Restoration process failed:', error);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Run the restore if this script is executed directly
if (require.main === module) {
  // Install commander if not already installed
  try {
    require('commander');
  } catch {
    console.error('Please install commander: npm install commander');
    process.exit(1);
  }

  const restore = new DatabaseRestore(options.backup, options.dryRun, options.force);
  restore.run().then(result => {
    if (result.success) {
      console.log('\n✅ Restoration completed successfully');
    } else if (result.cancelled) {
      console.log('\n⚠️  Restoration cancelled');
    } else {
      console.log('\n❌ Restoration failed');
      process.exit(1);
    }
  }).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = DatabaseRestore;