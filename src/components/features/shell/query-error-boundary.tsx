"use client";

import { Component, type ReactNode } from "react";

import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { t } from "@/lib/utils";

// Convex's useQuery throws during render when the server rejects the request
// (e.g. a URL id that fails validation — ids carry a checksum the client
// can't verify). The throw can only be caught by a boundary ABOVE the
// component that calls useQuery, so detail pages split their query-driven
// content into a child and wrap it in this boundary with key={id} (a new id
// remounts a fresh boundary).

type QueryErrorBoundaryProps = {
  children: ReactNode;
  fallbackTitle?: string;
  fallbackBody?: string;
};

type QueryErrorBoundaryState = { error: unknown };

export class QueryErrorBoundary extends Component<
  QueryErrorBoundaryProps,
  QueryErrorBoundaryState
> {
  state: QueryErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): QueryErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: unknown) {
    // Log the full error for debugging; the user only sees the card.
    console.error(error);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <Card>
          <CardHeader>
            <CardTitle>{this.props.fallbackTitle ?? t().common.noResults}</CardTitle>
            <CardDescription>{this.props.fallbackBody ?? t().errors.GENERIC}</CardDescription>
          </CardHeader>
        </Card>
      );
    }
    return this.props.children;
  }
}
