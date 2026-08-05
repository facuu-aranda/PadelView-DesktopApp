const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://xzbkatvfxeoulnopkytz.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh6YmthdHZmeGVvdWxub3BreXR6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4Mzc2NDQ1OCwiZXhwIjoyMDk5MzQwNDU4fQ.mDlTpLJObEhEe8Gp3MoWvHSmIt3XZ-SdYVffemAxCkA'
);

async function check() {
  const { data, error } = await supabase
    .from('matches')
    .select('*')
    .eq('id', 'edaab29d-bf9c-476a-bca6-0d0069f7eb32');
  
  console.log('Result:', data);
  console.log('Error:', error);
}

check();
