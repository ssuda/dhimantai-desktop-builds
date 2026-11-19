// OpenSSH invokes this short-lived process. Credentials travel only through a private loopback channel.
const http = require('node:http');
const body = JSON.stringify({prompt:process.argv.slice(2).join(' '),hint:process.env.SSH_ASKPASS_PROMPT,session:process.env.DHIMANTAI_SSH_ATTEMPT});
const request = http.request(process.env.DHIMANTAI_ASKPASS_URL, {
  method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},timeout:120000,
}, response => {
  let value='';response.setEncoding('utf8');
  response.on('data',chunk=>{value+=chunk;if(value.length>16000)request.destroy();});
  response.on('end',()=>{if(response.statusCode!==200)process.exit(1);process.stdout.write(value+'\n');});
});
request.on('timeout',()=>request.destroy());request.on('error',()=>process.exit(1));request.end(body);
