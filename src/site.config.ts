export interface SiteConfig {
  analytics: {
    enabled: boolean;
    url?: string;
    domain?: string;
  };
  avatar: string;
  bio: string;
  location: string;
  newsletter: {
    enabled: boolean;
    description?: string;
    /** Verified sender address for transactional emails. Must match an address
     *  in the send_email binding's allowed_sender_addresses. */
    senderAddress: string;
    /** Public Turnstile site key for widget rendering. */
    turnstileSiteKey?: string;
    /** Consent version string (semver-like, e.g. "1.0"). Increment when privacy policy changes. */
    consentVersion: string;
    /** Expected hostname for Turnstile token validation. Must match the widget's data-domain. */
    expectedHostname: string;
  };
  roles: string[];
  social: {
    github?: string;
    twitter?: string;
    linkedin?: string;
    email?: string;
  };
  url: string;
}

// Site identity (title, tagline, logo) and primary navigation are owned by the
// EmDash CMS at runtime (Settings and the "primary" menu). This config holds
// only presentation values with no EmDash equivalent; there are deliberately
// no local fallbacks for CMS-owned identity or navigation.
export const siteConfig: SiteConfig = {
  // Functional local default: matches the origin used by `bun run cf:dev`
  // (wrangler dev --local --port 8787), including for local WebAuthn passkeys.
  // Replace with your canonical HTTPS URL before any production deployment.
  url: "http://localhost:8787",
  avatar: "/avatar.svg",
  location: "Your City",
  roles: ["Software Engineer", "Open Source", "Builder"],
  bio: "I'm a software engineer who loves building things on the web. I write about what I'm learning, projects I'm working on, and ideas worth sharing.",
  social: {
    github: "https://github.com/yourusername",
    twitter: "https://x.com/yourusername",
    email: "hello@your-domain.com",
  },
  newsletter: {
    enabled: false,
    description:
      "Occasional notes on engineering, projects, and ideas. No spam.",
    senderAddress: "newsletter@your-domain.com",
    turnstileSiteKey: "",
    consentVersion: "1.0",
    expectedHostname: "your-domain.com",
  },
  analytics: {
    enabled: false,
    url: "https://your-analytics.com/api/script.js",
    domain: "your-domain.com",
  },
};
