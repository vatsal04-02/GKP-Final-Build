import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import { useWs } from '../lib/workspace';
import { EmptyState } from '../components/ui/feedback';
import { Button } from '../components/ui/primitives';
export default function NotFound() {
  const { ws } = useWs();
  return <EmptyState className="py-28" icon={<Compass className="h-5 w-5" />} title="This page is not part of this workspace" body="It may belong to a module that is switched off here." action={<Link to={`/w/${ws.id}`}><Button>Back to the dashboard</Button></Link>} />;
}
