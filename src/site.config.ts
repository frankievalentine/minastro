export interface SiteConfig {
  analytics: {
    enabled: boolean;
    url?: string;
    domain?: string;
  };
  avatar: string;
  bio: string;
  description: string;
  location: string;
  name: string;
  nav: Array<{ label: string; href: string }>;
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
  title: string;
  url: string;
}

export const siteConfig: SiteConfig = {
  name: "Your Name",
  title: "Your Name",
  description: "Your Name's personal website — engineer, maker, writer.",
  url: "https://your-domain.com",
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
  nav: [
    { label: "About", href: "/" },
    { label: "Posts", href: "/posts" },
    { label: "Projects", href: "/projects" },
  ],
};
