**Required WordPress Endpoint**

The app now expects a dedicated helper endpoint for verified `wc_cs_credits` data:

`GET /wp-json/red-spectrum/v1/wc-cs-credits?per_page=25&offset=0`

Optional filter:

`GET /wp-json/red-spectrum/v1/wc-cs-credits?email=customer@example.com&per_page=25&offset=0`

Response shape:

```json
{
  "records": [
    {
      "id": 164482,
      "title": { "rendered": "Credit Record 164482" },
      "meta": {
        "_approved_credits": "3500",
        "_available_credits": "3500",
        "_total_outstanding_amount": "0",
        "_next_bill_date": "2026-06-01",
        "_last_billed_date": "2026-05-01",
        "_billing_ein": "85-4097426",
        "_user_email": "customer@example.com",
        "_user_phone": "6783498879",
        "_user_company": "Elite1 Transport LLC"
      }
    }
  ],
  "total": 1,
  "source": "wc_cs_credits"
}
```

Use the PHP helper in [docs/wp-wc-cs-credits-helper-endpoint.php](E:\Office\RedSpectrumAdmin\red-spectrum-customer-intel\docs\wp-wc-cs-credits-helper-endpoint.php) inside a WordPress plugin or mu-plugin.

**Authentication**

The app sends this header on every request:

`X-Red-Spectrum-Secret: <WORDPRESS_CREDIT_API_SECRET>`

The WordPress helper should allow access if either:

- the requester is an authenticated admin with `manage_options`
- or the `X-Red-Spectrum-Secret` header matches the configured secret

Recommended WordPress secret setup:

```php
define('RED_SPECTRUM_WC_CREDIT_SECRET', 'replace-with-a-long-random-secret');
```

Place that in `wp-config.php`, then enable the helper snippet/plugin.

App env required:

```env
WORDPRESS_CREDIT_API_SECRET=replace-with-the-same-long-random-secret
```

Expected security behavior:

- browser request without login and without `X-Red-Spectrum-Secret` should be blocked
- admin request in WordPress should work
- app request with `X-Red-Spectrum-Secret` should work
