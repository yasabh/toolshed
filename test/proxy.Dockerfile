# The stand-in gatekeeper. Baked rather than bind-mounted: the docker context
# here points at the deployment host over ssh, so a path from this machine means
# nothing on the other end.
#
# No TLS. The real gatekeeper terminates HTTPS at its own front door and the hop
# to this app is plain HTTP either way, which is exactly what this reproduces.
FROM nginx:1.31.10-alpine3.24
COPY nginx.conf /etc/nginx/conf.d/default.conf
