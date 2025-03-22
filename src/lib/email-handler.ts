// @ts-nocheck
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import Imap from 'imap';
import Connection from "imap";

class EmailHandler {
    private currentRefreshToken: string;
    private email: string;
    private clientId: string;
    private proxyUrl: string;
    /**
     * Constructs a new EmailHandler instance.
     * @param {string} email - The email address to connect to.
     * @param {string} currentRefreshToken - The current refresh token for OAuth.
     * @param {string} clientId - The OAuth client ID.
     * @param {string|null} proxyUrl - Optional proxy URL.
     */
    constructor(email, currentRefreshToken, clientId, proxyUrl = null) {
        this.email = email;
        this.currentRefreshToken = currentRefreshToken;
        this.clientId = clientId;
        this.proxyUrl = proxyUrl;
    }

    /**
     * Retrieves an OAuth access token using the provided refresh token.
     * Tries a second attempt with an additional scope if the first fails.
     * @returns {Promise<string|null>} The access token if successful, otherwise null.
     */
    async getOAuthToken() {
        let token = null;
        const url = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
        const axiosConfig = {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        };

        if (this.proxyUrl) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(this.proxyUrl);
        }

        const postData = new URLSearchParams();
        postData.append('client_id', this.clientId);
        postData.append('refresh_token', this.currentRefreshToken);
        postData.append('grant_type', 'refresh_token');

        try {
            const response = await axios.post(url, postData, axiosConfig);
            token = response.data.access_token;
        } catch (error) {
            // Second attempt with an additional scope
            try {
                const postData2 = new URLSearchParams();
                postData2.append('client_id', this.clientId);
                postData2.append('refresh_token', this.currentRefreshToken);
                postData2.append('grant_type', 'refresh_token');
                postData2.append('scope', 'https://outlook.office.com/IMAP.AccessAsUser.All');
                const response2 = await axios.post(url, postData2, axiosConfig);
                token = response2.data.access_token;
            } catch (error2) {
            }
        }
        return token;
    }

    /**
     * Connects to the email server via IMAP using OAuth and searches for a message
     * that matches the given regular expression pattern.
     * @param {RegExp} regexPattern - Regular expression to extract data from the email.
     *                                The pattern should have a capturing group for the target data.
     * @returns {Promise<string>} The extracted data if a matching email is found.
     */
    async searchEmail(regexPattern) {
        const token = await this.getOAuthToken();
        if (!token) {
            throw new Error("Unable to retrieve OAuth token");
        }

        // Determine the IMAP host based on email provider.
        let host = 'outlook.office365.com';
        const lowerEmail = this.email.toLowerCase();
        if (!(lowerEmail.includes('outlook.com') || lowerEmail.includes('hotmail.com') || lowerEmail.includes('live.com'))) {
            // Adjust host for other providers if necessary.
            host = 'outlook.office365.com';
        }

        // Create the XOAUTH2 authentication string.
        const xoauth2 = Buffer.from(
            [`user=${this.email}`, `auth=Bearer ${token}`, '', ''].join('\x01'),
            'utf-8'
        ).toString('base64');

        // Prepare the IMAP configuration.
        const imapConfig = {
            xoauth2: xoauth2,
            host: host,
            port: 993,
            tls: true,
            authTimeout: 25000,
            connTimeout: 30000,
            tlsOptions: {
                rejectUnauthorized: false,
                servername: host
            }
        };

        return new Promise((resolve, reject) => {
            const imap = new Imap(imapConfig as Connection.Config);
            let matchFound = false;

            imap.once('ready', () => {
                // Retrieve the list of mailboxes.
                imap.getBoxes((err, boxes) => {
                    if (err) {
                        imap.end();
                        return reject(err);
                    }
                    const mailboxNames = Object.keys(boxes);

                    // Recursive function to process each mailbox.
                    const processMailbox = (mailboxes) => {
                        if (matchFound) return;
                        if (mailboxes.length === 0) {
                            imap.end();
                            if (!matchFound) return reject(new Error("No matching email found"));
                            return;
                        }
                        const mailbox = mailboxes.shift();
                        imap.openBox(mailbox, true, (err, box) => {
                            if (err) {
                                return processMailbox(mailboxes);
                            }
                            imap.search(['ALL'], (err, results) => {
                                if (err) {
                                    return processMailbox(mailboxes);
                                }
                                if (!results || results.length === 0) {
                                    return processMailbox(mailboxes);
                                }
                                const fetcher = imap.fetch(results, { bodies: '' });
                                fetcher.on('message', (msg, seqno) => {
                                    let buffer = '';
                                    msg.on('body', (stream) => {
                                        stream.on('data', (chunk) => {
                                            buffer += chunk.toString('utf8');
                                        });
                                        stream.once('end', () => {
                                            // Apply the regex to extract the desired data.
                                            const match = buffer.match(regexPattern);
                                            if (match && match[1]) {
                                                matchFound = true;
                                                resolve(match[1]);
                                                imap.end();
                                            }
                                        });
                                    });
                                    msg.once('error', (err) => {
                                    });
                                });
                                fetcher.once('error', (err) => {
                                });
                                fetcher.once('end', () => {
                                    processMailbox(mailboxes);
                                });
                            });
                        });
                    };

                    processMailbox(mailboxNames);
                });
            });

            imap.once('error', (err) => {
                reject(err);
            });

            imap.once('end', () => {
            });

            imap.connect();
        });
    }
}

export default EmailHandler;
