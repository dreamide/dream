import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { setChatRuntimeTranslators, startChatRuntime } from "./chat-runtime";

/**
 * Mounted once for the whole app. Starts the chat runtime and gives it the
 * current locale's translators, which it cannot reach on its own.
 */
export const ChatRuntimeHost = () => {
  const chatT = useTranslations("chat");
  const modelT = useTranslations("models");

  useEffect(() => {
    // Keys are chosen by the runtime, so they are not statically known here.
    type LooseTranslate = (
      key: string,
      values?: Record<string, string>,
    ) => string;
    setChatRuntimeTranslators({
      chat: chatT as unknown as LooseTranslate,
      models: modelT as unknown as LooseTranslate,
    });
    return () => setChatRuntimeTranslators(null);
  }, [chatT, modelT]);

  useEffect(() => {
    startChatRuntime();
  }, []);

  return null;
};
