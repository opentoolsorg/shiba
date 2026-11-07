export type IntegrationLogoAsset = { name: string; src: string };

const assets: Record<string, IntegrationLogoAsset> = {
  "google-ads": {
    "name": "Google Ads",
    "src": "/integration-logos/google-ads.svg"
  },
  "meta": {
    "name": "Meta",
    "src": "/integration-logos/meta.svg"
  },
  "twitter": {
    "name": "X",
    "src": "/integration-logos/twitter.svg"
  },
  "linkedin-icon": {
    "name": "LinkedIn",
    "src": "/integration-logos/linkedin-icon.svg"
  },
  "instagram-icon": {
    "name": "Instagram",
    "src": "/integration-logos/instagram-icon.svg"
  },
  "youtube-icon": {
    "name": "YouTube",
    "src": "/integration-logos/youtube-icon.svg"
  },
  "posthog-icon": {
    "name": "PostHog",
    "src": "/integration-logos/posthog-icon.svg"
  },
  "webflow": {
    "name": "Webflow",
    "src": "/integration-logos/webflow.svg"
  },
  "wix": {
    "name": "Wix",
    "src": "/integration-logos/wix.svg"
  },
  "hubspot": {
    "name": "HubSpot",
    "src": "/integration-logos/hubspot.svg"
  },
  "salesforce": {
    "name": "Salesforce",
    "src": "/integration-logos/salesforce.svg"
  },
  "google-gmail": {
    "name": "Gmail",
    "src": "/integration-logos/google-gmail.svg"
  },
  "google-calendar": {
    "name": "Google Calendar",
    "src": "/integration-logos/google-calendar.svg"
  },
  "microsoft-teams": {
    "name": "Microsoft Teams",
    "src": "/integration-logos/microsoft-teams.svg"
  },
  "microsoft-onedrive": {
    "name": "OneDrive",
    "src": "/integration-logos/microsoft-onedrive.svg"
  },
  "notion-icon": {
    "name": "Notion",
    "src": "/integration-logos/notion-icon.svg"
  },
  "google-drive": {
    "name": "Google Drive",
    "src": "/integration-logos/google-drive.svg"
  },
  "googledocs": {
    "name": "Google Docs",
    "src": "/integration-logos/googledocs.svg"
  },
  "googlesheets": {
    "name": "Google Sheets",
    "src": "/integration-logos/googlesheets.svg"
  },
  "telegram": {
    "name": "Telegram",
    "src": "/integration-logos/telegram.svg"
  },
  "discord-icon": {
    "name": "Discord",
    "src": "/integration-logos/discord-icon.svg"
  },
  "airtable": {
    "name": "Airtable",
    "src": "/integration-logos/airtable.svg"
  },
  "slack-icon": {
    "name": "Slack",
    "src": "/integration-logos/slack-icon.svg"
  },
  "stripe": {
    "name": "Stripe",
    "src": "/integration-logos/stripe.svg"
  },
  "square": {
    "name": "Square",
    "src": "/integration-logos/square.svg"
  },
  "figma": {
    "name": "Figma",
    "src": "/integration-logos/figma.svg"
  },
  "github-icon": {
    "name": "GitHub",
    "src": "/integration-logos/github-icon.svg"
  },
  "linear-icon": {
    "name": "Linear",
    "src": "/integration-logos/linear-icon.svg"
  },
  "jira": {
    "name": "Jira",
    "src": "/integration-logos/jira.svg"
  },
  "atlassian": {
    "name": "Atlassian",
    "src": "/integration-logos/atlassian.svg"
  },
  "sentry-icon": {
    "name": "Sentry",
    "src": "/integration-logos/sentry-icon.svg"
  },
  "monday-icon": {
    "name": "monday.com",
    "src": "/integration-logos/monday-icon.svg"
  },
  "asana-icon": {
    "name": "Asana",
    "src": "/integration-logos/asana-icon.svg"
  },
  "gitlab-icon": {
    "name": "GitLab",
    "src": "/integration-logos/gitlab-icon.svg"
  },
  "cloudflare-icon": {
    "name": "Cloudflare",
    "src": "/integration-logos/cloudflare-icon.svg"
  },
  "paypal": {
    "name": "PayPal",
    "src": "/integration-logos/paypal.svg"
  },
  "customerio-icon": {
    "name": "Customer.io",
    "src": "/integration-logos/customerio-icon.svg"
  },
  "confluence": {
    "name": "Confluence",
    "src": "/integration-logos/confluence.svg"
  },
  "neon-icon": {
    "name": "Neon",
    "src": "/integration-logos/neon-icon.svg"
  },
  "brevo": {
    "name": "Brevo",
    "src": "/integration-logos/brevo.svg"
  },
  "quickbooks": {
    "name": "QuickBooks",
    "src": "/integration-logos/quickbooks.svg"
  },
  "microsoftoutlook": {
    "name": "Outlook",
    "src": "/integration-logos/microsoftoutlook.svg"
  },
  "clickup": {
    "name": "ClickUp",
    "src": "/integration-logos/clickup.svg"
  },
  "baremetrics": {
    "name": "Baremetrics",
    "src": "/integration-logos/baremetrics.svg"
  },
  "apollo": {
    "name": "Apollo",
    "src": "/integration-logos/apollo.ico"
  },
  "attio": {
    "name": "Attio",
    "src": "/integration-logos/attio.ico"
  },
  "gong": {
    "name": "Gong",
    "src": "/integration-logos/gong.png"
  },
  "zoominfo": {
    "name": "ZoomInfo",
    "src": "/integration-logos/zoominfo.png"
  },
  "granola": {
    "name": "Granola",
    "src": "/integration-logos/granola.png"
  },
  "klaviyo": {
    "name": "Klaviyo",
    "src": "/integration-logos/klaviyo.png"
  },
  "fal": {
    "name": "fal",
    "src": "/integration-logos/fal.ico"
  },
  "krea": {
    "name": "Krea",
    "src": "/integration-logos/krea.ico"
  },
  "brightdata": {
    "name": "Bright Data",
    "src": "/integration-logos/brightdata.ico"
  },
  "moz": {
    "name": "Moz",
    "src": "/integration-logos/moz.ico"
  }
};

const aliases: Record<string, readonly string[]> = {
  "google-ads": [
    "google-ads"
  ],
  "meta-ads": [
    "meta"
  ],
  "x-twitter": [
    "twitter"
  ],
  "linkedin-instagram-youtube": [
    "linkedin-icon",
    "instagram-icon",
    "youtube-icon"
  ],
  "posthog": [
    "posthog-icon"
  ],
  "webflow": [
    "webflow"
  ],
  "wix": [
    "wix"
  ],
  "klaviyo-brevo": [
    "klaviyo",
    "brevo"
  ],
  "hubspot": [
    "hubspot"
  ],
  "salesforce": [
    "salesforce"
  ],
  "apollo": [
    "apollo"
  ],
  "attio": [
    "attio"
  ],
  "gong-zoominfo": [
    "gong",
    "zoominfo"
  ],
  "gmail-calendar": [
    "google-gmail",
    "google-calendar"
  ],
  "outlook-calendar": [
    "microsoftoutlook"
  ],
  "slack": [
    "slack-icon"
  ],
  "microsoft-teams": [
    "microsoft-teams"
  ],
  "notion": [
    "notion-icon"
  ],
  "google-drive-docs-sheets": [
    "google-drive",
    "googledocs",
    "googlesheets"
  ],
  "onedrive": [
    "microsoft-onedrive"
  ],
  "telegram": [
    "telegram"
  ],
  "discord": [
    "discord-icon"
  ],
  "airtable": [
    "airtable"
  ],
  "granola-meetings": [
    "granola"
  ],
  "stripe": [
    "stripe"
  ],
  "square": [
    "square"
  ],
  "quickbooks": [
    "quickbooks"
  ],
  "stripe-hubspot-reconcile": [
    "stripe",
    "hubspot"
  ],
  "figma": [
    "figma"
  ],
  "fal-krea": [
    "fal",
    "krea"
  ],
  "github": [
    "github-icon"
  ],
  "linear": [
    "linear-icon"
  ],
  "jira-atlassian": [
    "jira",
    "atlassian"
  ],
  "sentry": [
    "sentry-icon"
  ],
  "monday-clickup-asana": [
    "monday-icon",
    "clickup",
    "asana-icon"
  ],
  "gitlab": [
    "gitlab-icon"
  ],
  "google": [
    "google-gmail",
    "google-calendar"
  ],
  "outlook": [
    "microsoftoutlook"
  ],
  "twitter": [
    "twitter"
  ],
  "meta": [
    "meta"
  ],
  "instagram": [
    "instagram-icon"
  ],
  "youtube": [
    "youtube-icon"
  ],
  "linkedin": [
    "linkedin-icon"
  ],
  "gmail": [
    "google-gmail"
  ],
  "google_drive": [
    "google-drive"
  ],
  "google_docs": [
    "googledocs"
  ],
  "google_sheets": [
    "googlesheets"
  ],
  "google_calendar": [
    "google-calendar"
  ],
  "microsoft_teams": [
    "microsoft-teams"
  ],
  "microsoft_outlook": [
    "microsoftoutlook"
  ],
  "microsoft_onedrive": [
    "microsoft-onedrive"
  ],
  "granola": [
    "granola"
  ],
  "monday": [
    "monday-icon"
  ],
  "asana": [
    "asana-icon"
  ],
  "clickup": [
    "clickup"
  ],
  "jira": [
    "jira"
  ],
  "atlassian": [
    "atlassian"
  ],
  "cloudflare": [
    "cloudflare-icon"
  ],
  "paypal": [
    "paypal"
  ],
  "customer.io": [
    "customerio-icon"
  ],
  "customerio": [
    "customerio-icon"
  ],
  "neon": [
    "neon-icon"
  ],
  "baremetrics": [
    "baremetrics"
  ],
  "bright data social": [
    "brightdata"
  ],
  "deepwiki": [],
  "github (git & cli)": [
    "github-icon"
  ],
  "google drive": [
    "google-drive"
  ],
  "jira & confluence": [
    "jira",
    "confluence"
  ],
  "monday.com": [
    "monday-icon"
  ],
  "moz seo": [
    "moz"
  ],
  "posthog (eu)": [
    "posthog-icon"
  ],
  "linkedin-icon": [
    "linkedin-icon"
  ],
  "instagram-icon": [
    "instagram-icon"
  ],
  "youtube-icon": [
    "youtube-icon"
  ],
  "posthog-icon": [
    "posthog-icon"
  ],
  "google-gmail": [
    "google-gmail"
  ],
  "google-calendar": [
    "google-calendar"
  ],
  "microsoft-onedrive": [
    "microsoft-onedrive"
  ],
  "notion-icon": [
    "notion-icon"
  ],
  "google-drive": [
    "google-drive"
  ],
  "googledocs": [
    "googledocs"
  ],
  "googlesheets": [
    "googlesheets"
  ],
  "discord-icon": [
    "discord-icon"
  ],
  "slack-icon": [
    "slack-icon"
  ],
  "github-icon": [
    "github-icon"
  ],
  "linear-icon": [
    "linear-icon"
  ],
  "sentry-icon": [
    "sentry-icon"
  ],
  "monday-icon": [
    "monday-icon"
  ],
  "asana-icon": [
    "asana-icon"
  ],
  "gitlab-icon": [
    "gitlab-icon"
  ],
  "cloudflare-icon": [
    "cloudflare-icon"
  ],
  "customerio-icon": [
    "customerio-icon"
  ],
  "confluence": [
    "confluence"
  ],
  "neon-icon": [
    "neon-icon"
  ],
  "brevo": [
    "brevo"
  ],
  "microsoftoutlook": [
    "microsoftoutlook"
  ],
  "gong": [
    "gong"
  ],
  "zoominfo": [
    "zoominfo"
  ],
  "klaviyo": [
    "klaviyo"
  ],
  "fal": [
    "fal"
  ],
  "krea": [
    "krea"
  ],
  "brightdata": [
    "brightdata"
  ],
  "moz": [
    "moz"
  ],
  "google ads": [
    "google-ads"
  ],
  "google calendar": [
    "google-calendar"
  ],
  "microsoft teams": [
    "microsoft-teams"
  ],
  "google docs": [
    "googledocs"
  ],
  "google sheets": [
    "googlesheets"
  ],
  "bright data": [
    "brightdata"
  ]
};

/** Exact brand aliases only; unknown provider IDs must not borrow another brand. */
export function integrationLogos(key: string): IntegrationLogoAsset[] {
  return (aliases[key.trim().toLowerCase()] ?? []).flatMap((id) => assets[id] ? [assets[id]] : []);
}
