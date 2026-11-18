import { defineConfig } from "vitepress";

const repo = "https://github.com/bennet0904/lotse";

// The handbook for people who use and run Lotse. Developer documentation lives in docs/ in the repository.
export default defineConfig({
  title: "Lotse",
  description: "Turn a prompt into a running app and deploy it anywhere.",
  lang: "en-US",
  // Published at https://bennet0904.github.io/lotse/
  base: "/lotse/",
  cleanUrls: true,
  lastUpdated: true,
  head: [["link", { rel: "icon", href: "/lotse/favicon.svg", type: "image/svg+xml" }]],
  themeConfig: {
    logo: "/favicon.svg",
    nav: [
      { text: "Get started", link: "/start/introduction" },
      { text: "Handbook", link: "/build/first-app" },
      { text: "Administration", link: "/admin/install" },
      { text: "Status", link: "https://bennet0904.github.io/lotse/status/", target: "_self" },
      { text: "Download", link: `${repo}/releases/latest` },
    ],
    sidebar: [
      {
        text: "Get started",
        items: [
          { text: "What Lotse is", link: "/start/introduction" },
          { text: "Desktop app", link: "/start/desktop" },
          { text: "Command line", link: "/start/cli" },
          { text: "Web app for teams", link: "/start/web-app" },
        ],
      },
      {
        text: "Building apps",
        items: [
          { text: "Your first app", link: "/build/first-app" },
          { text: "Changing an app", link: "/build/changing" },
          { text: "Stacks", link: "/build/stacks" },
          { text: "Language models and cost", link: "/build/models" },
        ],
      },
      {
        text: "Providers",
        items: [
          { text: "Connecting accounts", link: "/providers/connecting" },
          { text: "Choosing a provider", link: "/providers/overview" },
          { text: "Your own server", link: "/providers/own-server" },
        ],
      },
      {
        text: "Publishing",
        items: [
          { text: "Publishing an app", link: "/publish/publishing" },
          { text: "Custom domains", link: "/publish/domains" },
          { text: "Secrets and settings", link: "/publish/secrets" },
          { text: "Databases and backups", link: "/publish/databases" },
        ],
      },
      {
        text: "Git platforms",
        items: [
          { text: "Keeping code in a repository", link: "/git/repository" },
          { text: "Automatic deployments", link: "/git/automatic-deployments" },
          { text: "Pages hosting", link: "/git/pages" },
        ],
      },
      {
        text: "Command line",
        items: [
          { text: "Deploying an existing project", link: "/cli/deploy" },
          { text: "lotse.yaml", link: "/cli/lotse-yaml" },
          { text: "Commands", link: "/cli/commands" },
        ],
      },
      {
        text: "Administration",
        items: [
          { text: "Installing the web app", link: "/admin/install" },
          { text: "People and sign-in", link: "/admin/people" },
          { text: "OAuth apps and the GitHub App", link: "/admin/provider-sign-in" },
          { text: "Security", link: "/admin/security" },
          { text: "Updates and backups", link: "/admin/maintenance" },
          { text: "Configuration reference", link: "/admin/configuration" },
        ],
      },
      {
        text: "Help",
        items: [
          { text: "Troubleshooting", link: "/help/troubleshooting" },
          { text: "Getting help", link: "/help/support" },
        ],
      },
    ],
    search: { provider: "local" },
    editLink: { pattern: `${repo}/edit/main/guide/:path`, text: "Improve this page" },
    socialLinks: [{ icon: "github", link: repo }],
    footer: { message: "Released under the Apache License 2.0.", copyright: "The Lotse contributors" },
  },
});
