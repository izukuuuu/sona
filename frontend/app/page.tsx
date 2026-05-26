import { Suspense } from 'react';
import { SonaWorkspace } from '@/features/workspace/SonaWorkspace';

export default function Home() {
  return (
    <Suspense fallback={null}>
      <SonaWorkspace />
    </Suspense>
  );
}
