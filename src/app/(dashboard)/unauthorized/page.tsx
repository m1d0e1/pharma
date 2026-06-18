import AccessDenied from '@/components/AccessDenied';

export default function UnauthorizedPage() {
  return (
    <div className="container mx-auto py-20">
      <AccessDenied />
    </div>
  );
}
