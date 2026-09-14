import { Router } from 'express';
import { privacyPolicyHtml } from '../content/privacy-policy.js';

export const privacyRouter = Router();

privacyRouter.get('/', (_request, response) => {
  response.status(200).type('html').send(privacyPolicyHtml);
});
