export const privacyPolicyHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Privacy Policy for the SnapGen Video Middleware.">
  <title>Privacy Policy – SnapGen Video Middleware</title>
  <style>
    :root { color-scheme: light; --ink: #172033; --muted: #59657a; --line: #dfe5ee; --accent: #2457d6; --surface: #ffffff; --page: #f4f7fb; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--page); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; }
    main { width: min(100% - 2rem, 800px); margin: 3rem auto; padding: clamp(1.5rem, 5vw, 3.5rem); background: var(--surface); border: 1px solid var(--line); border-radius: 18px; box-shadow: 0 18px 50px rgba(31, 45, 74, .08); }
    h1 { margin: 0 0 .5rem; font-size: clamp(2rem, 6vw, 3rem); line-height: 1.15; letter-spacing: -.035em; }
    h2 { margin: 2rem 0 .5rem; font-size: 1.2rem; line-height: 1.35; }
    p, li { color: var(--muted); }
    ul { padding-left: 1.25rem; }
    .eyebrow { margin: 0 0 .75rem; color: var(--accent); font-size: .78rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .effective { margin: 0 0 2rem; color: var(--muted); }
    a { color: var(--accent); text-underline-offset: 3px; }
    footer { margin-top: 2.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: .9rem; color: var(--muted); }
    @media (max-width: 520px) { main { width: 100%; margin: 0; border: 0; border-radius: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">SnapGen Video Middleware</p>
    <h1>Privacy Policy</h1>
    <p class="effective"><strong>Effective date:</strong> September 14, 2026</p>

    <h2>1. Purpose</h2>
    <p>SnapGen Video Middleware is an integration service used to forward AI video generation requests from a configured ChatGPT GPT Action to the SnapGen API.</p>

    <h2>2. Data We Process</h2>
    <p>The service may process information necessary to perform video generation requests, including:</p>
    <ul>
      <li>video generation prompts;</li>
      <li>the requested model, duration, resolution, and aspect ratio;</li>
      <li>reference image URLs when supplied;</li>
      <li>generation UUIDs and generation status; and</li>
      <li>technical request metadata required for operation and troubleshooting.</li>
    </ul>

    <h2>3. How We Use Data</h2>
    <p>This information is used only to submit video generation requests, retrieve generation status, return generated video URLs, and operate, secure, troubleshoot, and monitor the middleware.</p>

    <h2>4. Third-Party Processing</h2>
    <p>Video generation requests are forwarded to SnapGen and may consequently be processed by the underlying AI or video generation providers used by SnapGen. The terms and privacy policies of SnapGen and those providers may apply to data they process. This policy does not make representations about their data retention practices.</p>

    <h2>5. API Credentials</h2>
    <p>Authentication credentials, including the middleware and SnapGen API credentials, are maintained as server-side secrets and are not intentionally exposed to end users through the API.</p>

    <h2>6. Logging</h2>
    <p>The middleware may maintain limited technical logs for security, reliability, monitoring, and troubleshooting. The application is designed not to intentionally log API keys or authentication secrets.</p>

    <h2>7. Generated Content</h2>
    <p>Generated video URLs and generation status information may be returned to the requesting user after processing by the external generation service.</p>

    <h2>8. Security</h2>
    <p>Reasonable technical measures are used to protect the middleware, including API authentication and HTTPS transport in production. No method of transmission or operation can be guaranteed to be completely secure.</p>

    <h2>9. User Responsibility</h2>
    <p>Users should not submit sensitive, confidential, or personally identifiable information in video prompts or reference material unless they have an appropriate reason and authorization to do so.</p>

    <h2>10. Changes to This Policy</h2>
    <p>This Privacy Policy may be updated as the service, its features, or its integrations evolve. The effective date shown above will identify the current version.</p>

    <h2>11. Contact</h2>
    <p>Questions about this Privacy Policy may be sent to <a href="mailto:wssitconsultoria@gmail.com">wssitconsultoria@gmail.com</a>.</p>

    <footer>Privacy Policy – SnapGen Video Middleware</footer>
  </main>
</body>
</html>`;
