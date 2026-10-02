import { redirect } from "next/navigation";

import { assistantHref, sanitizeContext } from "@/lib/assistant-link";
import { firstValue } from "@/lib/search-params";

/**
 * `/book` is no longer a way in: a booking starts in the assistant. Old links land there.
 * Only a well-formed service id survives; a time in the URL is dropped, because the agent has
 * to offer times itself. `ConfirmForm`, its Server Action and `POST /v1/appointments` stay in
 * this folder and are reached from the review card inside the chat.
 */
export default async function BookPage(props: PageProps<"/book">) {
  const searchParams = await props.searchParams;
  redirect(
    assistantHref(
      sanitizeContext({ service: firstValue(searchParams.service) }),
    ),
  );
}
