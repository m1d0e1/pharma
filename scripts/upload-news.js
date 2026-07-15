const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '../.env.local');
let serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  const match = envContent.match(/^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m);
  if (match) {
    serviceKey = match[1].trim();
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ntaaxbjeoqyetrmxyktf.supabase.co';

if (!serviceKey) {
  console.error('❌ Error: SUPABASE_SERVICE_ROLE_KEY is not defined in your environment or .env.local file.');
  console.error('Please add it to .env.local to run this script:');
  console.error('SUPABASE_SERVICE_ROLE_KEY=your_service_role_key_here');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, serviceKey);

async function uploadNews() {
  const newsPath = path.join(__dirname, '../news.json');
  if (!fs.existsSync(newsPath)) {
    console.error('❌ news.json file not found.');
    process.exit(1);
  }

  const newsData = fs.readFileSync(newsPath);

  console.log('Uploading news.json to Supabase Storage (app-news bucket)...');
  const { data, error } = await supabase.storage
    .from('app-news')
    .upload('news.json', newsData, {
      contentType: 'application/json',
      upsert: true
    });

  if (error) {
    console.error('❌ Upload failed:', error.message);
    process.exit(1);
  }

  console.log('✅ news.json uploaded successfully!', data);
}

uploadNews();
