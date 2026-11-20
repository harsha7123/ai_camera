"use client";

import type { ReactNode } from "react";
import { useApp } from "@/lib/store";
import { PERMISSION_LABEL, ROLE_LABEL } from "@/lib/present";
import type { Permission } from "@/lib/types";
import { EmptyState } from "./ui";

export function RequirePermission({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { can, me } = useApp();
  if (!can(perm)) {
    return (
      <EmptyState title="You don't have access to this page">
        <span data-testid="permission-gate" data-permission={perm}>
          This page needs the “{PERMISSION_LABEL[perm]}” permission, which your role ({ROLE_LABEL[me.user.role] ?? me.user.role}) does not include. Ask the owner or an
          administrator if you need it.
        </span>
      </EmptyState>
    );
  }
  return <>{children}</>;
}
