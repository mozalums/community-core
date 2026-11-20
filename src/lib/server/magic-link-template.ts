// Vendored from a LoremLabs Maizzle template (auth-link-01), rendered once and
// then cut loose from one community: every string that named a site is a
// sentinel that `magicLinkEmailParts` fills at send time.
//
//   %%MAGIC_LINK%%  the sign-in URL
//   %%BASE_URL%%    this deployment's https://www. origin, for the links and the logo
//   %%EMAIL_LOGO%%  the skin's brand.email_logo, a path under that origin
//   %%ACCENT%%      the skin's light-mode accent, for the button and the signature
//   %%ACCENT_CONTRAST%% the text color on that accent
//   %%SUBJECT%%     the skin's mail.sign_in_subject, also the title and the label
//   %%SITE_NAME%%   the skin's site.name, the logo's alt text
//   %%SIGNATURE%%   the skin's mail.signature
//   %%CREDIT%%      the skin's mail.credit line, or nothing
//
// The three Google Fonts <link> tags are left out: they requested a face no rule
// applies, and `stripRemoteFontLinks` drops them again at send time if a
// re-render brings them back. A re-render from the Maizzle source has to put the
// sentinels back by hand.

export const MAGIC_LINK_EMAIL_HTML = String.raw`<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
  <meta charset="utf-8">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <script type="application/ld+json">
    {
      "@context": "http://schema.org",
      "@type": "EmailMessage",
      "description": "Login and Claim Identity",
      "potentialAction": {
        "@type": "ViewAction",
        "target": "%%MAGIC_LINK%%",
        "url": "%%MAGIC_LINK%%",
        "name": "Login"
      }
    }
  </script>
  <!--[if mso]>
			<noscript>
				<xml>
					<o:OfficeDocumentSettings xmlns:o="urn:schemas-microsoft-com:office:office">
						<o:PixelsPerInch>96</o:PixelsPerInch>
					</o:OfficeDocumentSettings>
				</xml>
			</noscript>
			<style>
				td,
				th,
				div,
				p,
				a,
				h1,
				h2,
				h3,
				h4,
				h5,
				h6 {
					font-family: 'Segoe UI', sans-serif;
					mso-line-height-rule: exactly;
				}
			</style>
		<![endif]-->
  <title>%%SUBJECT%%</title>
  <style>
    .shadow-sm {
      --tw-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
      --tw-shadow-colored: 0 1px 2px 0 var(--tw-shadow-color);
      box-shadow: var(--tw-ring-offset-shadow, 0 0 #0000), var(--tw-ring-shadow, 0 0 #0000), var(--tw-shadow)
    }
    .hover-opacity-95:hover {
      opacity: 0.95 !important
    }
    @media (max-width: 600px) {
      .sm-w-full {
        width: 100% !important
      }
      .sm-px-6 {
        padding-left: 24px !important;
        padding-right: 24px !important
      }
      .sm-py-8 {
        padding-top: 32px !important;
        padding-bottom: 32px !important
      }
    }
  </style>
</head>
<body style="margin: 0; width: 100%; background-color: #f8fafc; padding: 0; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; word-break: break-word">
  <div style="display: none">
    Is this what you are looking for?
    &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847; &#847;
  </div>
  <div role="article" aria-roledescription="email" aria-label="%%SUBJECT%%" lang="en">
    <table style="width: 100%; font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;" cellpadding="0" cellspacing="0" role="none">
      <tr>
        <td align="center" style="background-color: #e5e7eb">
          <table class="sm-w-full" style="width: 600px" cellpadding="0" cellspacing="0" role="none">
            <tr>
              <td class="sm-py-8 sm-px-6" style="padding: 48px; text-align: center">
                <a href="%%BASE_URL%%/?utm_source=login">
                  <img src="%%BASE_URL%%/%%EMAIL_LOGO%%" alt="%%SITE_NAME%%" width="220" style="max-width: 100%; vertical-align: middle; border: 0">
                </a>
              </td>
            </tr>
            <tr>
              <td align="center" class="sm-px-6">
                <table style="width: 100%;" cellpadding="0" cellspacing="0" role="none">
                  <tr>
                    <td class="shadow-sm sm-px-6" style="border-radius: 4px; background-color: #f9fafb; padding: 48px; text-align: left; font-size: 16px; line-height: 24px; color: #334155; box-shadow: 0 0 #0000, 0 0 #0000, var(--tw-shadow)">
                      <p style="margin: 0; margin-bottom: 24px">
                        Please confirm your email address by clicking the button below:
                      </p>
                      <div style="line-height: 100%">
                        <a href="%%MAGIC_LINK%%" class="hover-opacity-95" style="display: inline-block; border-radius: 4px; background-color: %%ACCENT%%; padding-left: 16px; padding-right: 16px; padding-top: 14px; padding-bottom: 14px; text-align: center; font-size: 16px; font-weight: 600; color: %%ACCENT_CONTRAST%%; text-decoration: none">
                          <!--[if mso]>
														<i style="letter-spacing: 24px">&#8202;</i>
													<![endif]-->
                          <span>Confirm email address &rarr;</span>
                          <!--[if mso]>
														<i style="letter-spacing: 24px;">&#8202;</i>
													<![endif]-->
                        </a>
                      </div>
                      <table role="separator" style="width: 100%;" cellpadding="0" cellspacing="0">
                        <tr>
                          <td style="padding-top: 32px; padding-bottom: 32px">
                            <div style="height: 1px; background-color: #e2e8f0; line-height: 1px">&zwnj;</div>
                          </td>
                        </tr>
                      </table>
                      <p style="margin: 0; margin-bottom: 16px">
                        If you don't know what this is about, please ignore this email.
                      </p>
                      <p style="margin: 0;">
                        Thanks, <br><span style="font-weight: 800; font-style: italic"><a href="%%BASE_URL%%/" style="color: %%ACCENT%%">%%SIGNATURE%%</a></span>
                      </p>
%%CREDIT%%                    </td>
                  </tr>
                  <tr role="separator">
                    <td style="height: 48px"></td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>`;
