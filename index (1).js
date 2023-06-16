const fs = require("fs").promises;
const path = require("path");
const process = require("process");
const { authenticate } = require("@google-cloud/local-auth");
const { google } = require("googleapis");
const { log } = require("console");

function automateMails() {
  async function authorize() {
    const SCOPES = ["https://mail.google.com/"];
    const TOKEN_PATH = path.join(process.cwd(), "token.json");
    const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");

    /**
     * Reads previously authorized credentials from the save file.
     *
     * @return {Promise<OAuth2Client|null>}
     */
    async function loadSavedCredentialsIfExist() {
      try {
        const content = await fs.readFile(TOKEN_PATH);
        const credentials = JSON.parse(content);
        return google.auth.fromJSON(credentials);
      } catch (err) {
        return null;
      }
    }

    /**
     * Serializes credentials to a file compatible with GoogleAUth.fromJSON.
     *
     * @param {OAuth2Client} client
     * @return {Promise<void>}
     */
    async function saveCredentials(client) {
      const content = await fs.readFile(CREDENTIALS_PATH);
      const keys = JSON.parse(content);
      const key = keys.installed || keys.web;
      const payload = JSON.stringify({
        type: "authorized_user",
        client_id: key.client_id,
        client_secret: key.client_secret,
        refresh_token: client.credentials.refresh_token,
      });
      await fs.writeFile(TOKEN_PATH, payload);
    }

    /**
     * Load or request or authorization to call APIs.
     *
     */

    let client = await loadSavedCredentialsIfExist();
    if (!client) {
      client = await authenticate({
        scopes: SCOPES,
        keyfilePath: CREDENTIALS_PATH,
      });
      if (client.credentials) {
        await saveCredentials(client);
      }
    }
  }

  async function automateReply() {
    const credentials = require("./credentials.json");
    const tokens = require("./token.json");
    const MailComposer = require("nodemailer/lib/mail-composer");
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const auth = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );
    auth.setCredentials(tokens);
    const gmail = google.gmail({ version: "v1", auth });
    let label_id = "";

    // Function to create label
    async function createLabel() {
      const new_label = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: "Vacation Mails",
        },
      });
      return new_label.data.id;
    }

    // List of labels
    const labels_list = await gmail.users.labels.list({
      userId: "me",
    });
    const labels = labels_list.data.labels;
    labels.forEach((label) => {
      if (label.name === "Vacation Mails") {
        label_id = label.id;
      }
    });
    if (label_id === "") {
      label_id = await createLabel();
    }

    // List of sent mails
    const sent = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["SENT"],
    });
    const sent_mails = sent.data.messages;

    // List of new mails
    const received = await gmail.users.messages.list({
      userId: "me",
      labelIds: ["UNREAD"],
      maxResults: 10,
    });
    const new_mails = received.data.messages;
    if (!new_mails) {
      log("No new mails");
      return;
    }

    // Function to filter required mails
    const filterByReference = (arr1, arr2) => {
      let res = [];
      res = arr1.filter((el) => {
        return !arr2.find((element) => {
          return element.threadId === el.threadId;
        });
      });
      return res;
    };
    let reply_mails = new_mails;
    if (sent_mails) {
      reply_mails = filterByReference(new_mails, sent_mails);
    }
    if (!reply_mails.length) {
      log("No mails to reply");
      return;
    }
    if(reply_mails.length === 1) {
      log("Received", reply_mails.length, "new mail from - ")    
    }
    else {
      log("Received a total of", reply_mails.length, "new mails from - ")    
    }
    Promise.all(
      reply_mails.map(async (mail) => {
        // Fetch details of each new mail
        const getMail = await gmail.users.messages.get({
          userId: "me",
          id: mail.id,
        });
        return getMail.data.payload.headers;
      })
    )
      .then((response) => {
        // log(response)
        for (let i = 0; i < response.length; i++) {
          response[i].map((header) => {
            if (header.name === "From") {
              let mail = header.value.split(" ").pop().slice(1, -1);
              reply_mails[i].to = mail;
              log(mail)
            }
            if (header.name === "Message-ID") {
              reply_mails[i].message_id = header.value;
            }
            if (header.name === "Subject") {
              reply_mails[i].subject = header.value;
            }
          });
        }
      })
      .then(() => {
        // Encode message
        const encodeMessage = (message) => {
          return Buffer.from(message)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        };

        // Function to send a mail
        const createMail = async (options) => {
          const mailComposer = new MailComposer(options);
          const message = await mailComposer.compile().build();
          return encodeMessage(message);
        };
        Promise.all(
          reply_mails.map(async (mail) => {
            let sender = mail.to
            // Sending replies to new mails
            const options = {
              to: mail.to,
              cc: "",
              subject: mail.subject,
              replyTo: "me",
              text: "This is an automated mail\nI am on vacation. I will reply you when I will be back :)",
              textEncoding: "base64",
              headers: [
                { key: "X-Application-Developer", value: "Developer" },
                { key: "X-Application-Version", value: "v1.0.0.2" },
                { key: "References", value: mail.message_id },
                { key: "In-Reply-To", value: mail.message_id },
              ],
            };
            const rawMessage = await createMail(options);
            const { data: { id, threadId } = {} } = await gmail.users.messages.send({
              userId: "me",
              resource: {
                raw: rawMessage,
                threadId: mail.threadId,
              },
            });
            log("\nReply sent to", mail.to, "successfully")
            return { id, threadId};
          })
        ).then((replies) => {
          Promise.all(
            replies.map(async (reply) => {
              // Adding labels to new mails
              const addLabel = await gmail.users.threads.modify({
                userId: "me",
                id: reply.threadId,
                requestBody: {
                  addLabelIds: [label_id],
                  removeLabelIds: ["UNREAD"],
                },
              });
              return addLabel;
            })
          );
        });
      });
  }

  // Function to repeat process 
const setRandomInterval = (intervalFunction, minDelay, maxDelay) => {
  let timeout;

  const runInterval = () => {
    const timeoutFunction = () => {
      intervalFunction();
      runInterval();
    };
    let delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    log("Checking inbox in", delay, "secs")
    delay *= 1000;
    timeout = setTimeout(timeoutFunction, delay);
  };

  runInterval();

  return {
    clear() {
      clearTimeout(timeout);
    },
  };
};

// Executing the process in random intervals
  authorize().then(() => {setRandomInterval(automateReply, 45, 120)}).catch(console.error);
}

automateMails();

