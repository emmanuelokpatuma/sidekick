const { Readable } = require("node:stream");

function adapt(handler) {
  return async (request) => {
    const req = request.body ? Readable.fromWeb(request.body) : Readable.from([]);
    req.method = request.method;
    req.headers = Object.fromEntries(request.headers);

    const headers = new Headers();
    let body;
    const res = {
      statusCode: 200,
      setHeader(name, value) {
        headers.set(name, String(value));
      },
      end(value) {
        body = value;
      },
    };

    await handler(req, res);
    return new Response(request.method === "HEAD" ? null : body, {
      status: res.statusCode,
      headers,
    });
  };
}

module.exports = { adapt };
