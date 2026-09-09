export function validateOperatorOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("operator URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("operator URL must be an origin without credentials, query, fragment, or path");
  }
  return url.origin;
}
