import { getTranslations } from "next-intl/server";

import { ArrowRight } from "lucide-react";

import { EmptyAction } from "@/components/learn/empty-state";
import ExportNotes from "@/components/me/export-notes";
import LoadError from "@/components/me/load-error";
import NotesBrowser from "@/components/me/notes-browser";
import { PageHead } from "@/components/me/page-head";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { backendErrorText } from "@/lib/backend-error-server";
import { meFetch } from "@/lib/me/server";
import type { NotesPage } from "@/lib/me/types";
import { privatePageMetadata } from "@/lib/page-metadata";

export async function generateMetadata() {
  return privatePageMetadata("me.nav.notes");
}

export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<{ course?: string }>;
}) {
  const { course } = await searchParams;
  const t = await getTranslations("me.notes");

  const notes = await meFetch<NotesPage>("/api/me/annotations?page=1&limit=100").catch((e: Error) => e);
  const courseId = Number(course);

  return (
    <>
      <PageHead
        eyebrow={t("eyebrow")}
        title={t("title")}
        description={t("description")}
        actions={!(notes instanceof Error) && notes.total > 0 ? <ExportNotes /> : undefined}
      />
      {notes instanceof Error ? (
        <LoadError message={await backendErrorText(notes)} />
      ) : notes.total === 0 ? (
        <EmptyAction title={t("empty_title")} text={t("empty_text")}>
          <Button asChild>
            <Link href="/learn">
              {t("empty_cta")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        </EmptyAction>
      ) : (
        <NotesBrowser initial={notes} initialCourse={Number.isInteger(courseId) && courseId > 0 ? courseId : null} />
      )}
    </>
  );
}
