import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Empty({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={32} />
      <strong className="secondary">{title}</strong>
      {children && <div className="small">{children}</div>}
    </div>
  );
}
