export interface SiteConfig {
  name: string;
  title: string;
  description: string;
  url: string;
  avatar: string;
  location: string;
  roles: string[];
  bio: string;
  social: {
    github?: string;
    twitter?: string;
    linkedin?: string;
    email?: string;
  };
  newsletter: {
    enabled: boolean;
    formUrl?: string;
    description?: string;
  };
  analytics: {
    enabled: boolean;
    url?: string;
    domain?: string;
  };
  nav: Array<{ label: string; href: string }>;
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
    enabled: true,
    formUrl: "https://your-newsletter-service.com/subscribe",
    description: "Occasional notes on engineering, projects, and ideas. No spam.",
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
    { label: "Newsletter", href: "/newsletter" },
  ],
};
