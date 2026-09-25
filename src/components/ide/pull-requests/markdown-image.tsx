import { type ComponentProps, useState } from "react";

type MarkdownImageProps = ComponentProps<"img"> & { node?: unknown };

// GitHub comments (bot comments especially) use images as inline icons inside
// text and table cells: avatars sized with width/height, status badges next to
// a link. Render them inline like GitHub does instead of Streamdown's block
// image card, and fall back to the alt text when an image fails to load.
export function PrMarkdownImage({
  node: _node,
  alt,
  className: _className,
  onError,
  ...props
}: MarkdownImageProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !props.src) {
    return alt ? <span>{alt}</span> : null;
  }

  return (
    <img
      {...props}
      alt={alt ?? ""}
      className="inline-block max-w-full align-middle"
      loading="lazy"
      onError={(event) => {
        setFailed(true);
        onError?.(event);
      }}
    />
  );
}
