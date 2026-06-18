import { redirect } from 'next/navigation';

export default function SetupPage() {
  // Setup is now handled in the Login page via 'Initial Sync'
  redirect('/login');
}
