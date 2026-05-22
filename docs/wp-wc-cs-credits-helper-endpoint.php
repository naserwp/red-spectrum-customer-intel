<?php
/**
 * Red Spectrum wc_cs_credits helper endpoint
 *
 * Add this to a small mu-plugin or site plugin on WordPress.
 * It exposes the wc_cs_credits custom post type plus all post meta
 * needed by the Red Spectrum admin dashboard.
 */

add_action('rest_api_init', function () {
    register_rest_route('red-spectrum/v1', '/wc-cs-credits', [
        'methods'  => WP_REST_Server::READABLE,
        'permission_callback' => function (WP_REST_Request $request) {
            if (current_user_can('manage_options')) {
                return true;
            }

            $configured_secret = '';

            if (defined('RED_SPECTRUM_WC_CREDIT_SECRET')) {
                $configured_secret = (string) RED_SPECTRUM_WC_CREDIT_SECRET;
            }

            if (!$configured_secret) {
                $configured_secret = (string) get_option('red_spectrum_wc_credit_secret', '');
            }

            $request_secret = (string) $request->get_header('X-Red-Spectrum-Secret');

            return $configured_secret !== '' && $request_secret !== '' && hash_equals($configured_secret, $request_secret);
        },
        'callback' => function (WP_REST_Request $request) {
            $per_page = max(1, min(25, (int) $request->get_param('per_page')));
            $offset   = max(0, (int) $request->get_param('offset'));
            $email    = sanitize_email((string) $request->get_param('email'));

            $query_args = [
                'post_type'      => 'wc_cs_credits',
                'post_status'    => 'any',
                'posts_per_page' => $per_page,
                'offset'         => $offset,
                'orderby'        => 'ID',
                'order'          => 'DESC',
            ];

            if ($email) {
                $query_args['meta_query'] = [[
                    'key'     => '_user_email',
                    'value'   => $email,
                    'compare' => '=',
                ]];
            }

            $query = new WP_Query($query_args);
            $records = [];

            foreach ($query->posts as $post) {
                $meta_rows = get_post_meta($post->ID);
                $meta = [];
                foreach ($meta_rows as $key => $values) {
                    if (!empty($values)) {
                        $meta[$key] = maybe_unserialize($values[0]);
                    }
                }

                $records[] = [
                    'id'    => (int) $post->ID,
                    'title' => [
                        'rendered' => get_the_title($post),
                    ],
                    'meta'  => $meta,
                ];
            }

            return new WP_REST_Response([
                'records' => $records,
                'total'   => (int) $query->found_posts,
                'source'  => 'wc_cs_credits',
                'required_meta_keys' => [
                    '_approved_credits',
                    '_available_credits',
                    '_total_outstanding_amount',
                    '_next_bill_date',
                    '_last_billed_date',
                    '_billing_ein',
                    '_user_email',
                    '_user_phone',
                    '_user_company',
                    '_user_first_name',
                    '_user_last_name',
                    '_user_address_1',
                    '_user_address_2',
                    '_user_city',
                    '_user_state',
                    '_user_postcode',
                    '_user_country',
                ],
            ], 200);
        },
    ]);
});
