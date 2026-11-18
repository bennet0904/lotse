# Custom domains

Every published app has an address from its provider, e.g. `guest-book.vercel.app`. To use your own domain, such as `booking.example.com`:

1. In the project's **Publish** tab, enter it under **Custom domain** and choose **Add domain**.
2. Confirm **Add this domain?**.
3. Lotse shows the DNS records to create, e.g. `CNAME booking.example.com → cname.vercel-dns.com`. Create them at the company where your domain is registered (its DNS settings).
4. Once the records are visible, which usually takes minutes and at most a day, the provider issues an HTTPS certificate and the app is reachable at the domain.

## On your own server

Create an `A` record (and `AAAA` for IPv6) for the domain pointing to your server's IP address. Caddy on the server obtains the certificate as soon as the record is visible.

To give every app on the server an address under one domain without adding each one, set a [domain for apps](../providers/own-server#addresses-of-your-apps) when connecting the server.

## Where domains cannot be added

GitLab Pages and Codeberg Pages manage custom domains in the platform itself: add the domain in the repository's Pages settings there.

## Moving a domain

A domain belongs to the app at one provider. If you publish the app to another provider, add the domain there and change the DNS records to what that provider shows. Domains listed under `domains` in the app's [`lotse.yaml`](../cli/lotse-yaml) are added at every deployment, wherever the app goes.
