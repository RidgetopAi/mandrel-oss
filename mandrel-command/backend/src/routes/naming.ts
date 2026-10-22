import { Router } from 'express';
import { NamingController } from '../controllers/naming';
import { authenticateToken } from '../middleware/auth';
import { validateUUIDParam } from '../middleware/validation';
import { declareAnyAuthenticatedMayWrite } from '../middleware/authz';

const router = Router();

// Apply authentication to all naming routes
router.use(authenticateToken);

// Naming routes

/**
 * @swagger
 * /naming:
 *   get:
 *     summary: Search naming registry entries
 *     tags: [Naming]
 *     parameters:
 *       - in: query
 *         name: query
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [variable, function, component, class, interface, module, file]
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [active, deprecated, conflicted, pending]
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *       - in: query
 *         name: date_from
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: date_to
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Entries retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/NamingSearchResponse'
 */
router.get('/', NamingController.searchEntries);

/**
 * @swagger
 * /naming/stats:
 *   get:
 *     summary: Retrieve naming registry statistics
 *     tags: [Naming]
 *     parameters:
 *       - in: query
 *         name: project_id
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Statistics returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/NamingStats'
 */
router.get('/stats', NamingController.getNamingStats);

/**
 * @swagger
 * /naming/check/{name}:
 *   get:
 *     summary: Check naming entry availability
 *     tags: [Naming]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [variable, function, component, class, interface, module, file]
 *         description: Optional type hint for the suggestion engine
 *     responses:
 *       200:
 *         description: Availability result
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/NamingAvailabilityResponse'
 */
router.get('/check/:name', NamingController.checkNameAvailability);

/**
 * @swagger
 * /naming/suggest/{name}:
 *   get:
 *     summary: Provide naming suggestions
 *     tags: [Naming]
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Suggestions returned
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/NamingSuggestion'
 */
router.get('/suggest/:name', NamingController.getSuggestions);

/**
 * @swagger
 * /naming/register:
 *   post:
 *     summary: Register a new naming entry
 *     tags: [Naming]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RegisterNamingRequest'
 *     responses:
 *       201:
 *         description: Naming entry registered
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/NamingEntry'
 */
router.post(
  '/register',
  declareAnyAuthenticatedMayWrite('registering a name is additive'),
  NamingController.registerName
);

/**
 * @swagger
 * /naming/{id}:
 *   get:
 *     summary: Get naming entry by ID
 *     tags: [Naming]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Entry retrieved
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiSuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       $ref: '#/components/schemas/NamingEntry'
 *   put:
 *     summary: Update naming entry
 *     tags: [Naming]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/UpdateNamingRequest'
 *     responses:
 *       200:
 *         description: Entry updated
 *   delete:
 *     summary: Delete naming entry
 *     tags: [Naming]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Entry deleted
 */
router.get('/:id', validateUUIDParam(), NamingController.getEntry);
router.put(
  '/:id',
  declareAnyAuthenticatedMayWrite('editing a naming entry is reversible'),
  validateUUIDParam(),
  NamingController.updateEntry
);
router.delete(
  '/:id',
  declareAnyAuthenticatedMayWrite('deleting ONE naming entry; single-row blast radius'),
  validateUUIDParam(),
  NamingController.deleteEntry
);

export default router;
